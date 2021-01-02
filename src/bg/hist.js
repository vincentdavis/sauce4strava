/* global sauce, browser */

sauce.ns('hist', async ns => {
    'use strict';

    const namespace = 'hist';
    const extUrl = browser.runtime.getURL('');
    const jobs = await sauce.getModule(extUrl + 'src/common/jscoop/jobs.js');
    const queues = await sauce.getModule(extUrl + 'src/common/jscoop/queues.js');
    const futures = await sauce.getModule(extUrl + 'src/common/jscoop/futures.js');
    const locks = await sauce.getModule(extUrl + 'src/common/jscoop/locks.js');
    const DBTrue = 1;
    const DBFalse = 0;

    const actsStore = new sauce.hist.db.ActivitiesStore();
    const streamsStore = new sauce.hist.db.StreamsStore();
    const athletesStore = new sauce.hist.db.AthletesStore();


    sauce.hist.db.ActivityModel.setSyncManifest('streams', [{
        version: 1,
        errorBackoff: 86400 * 1000,
        data: new Set([
            'time',
            'heartrate',
            'altitude',
            'distance',
            'moving',
            'velocity_smooth',
            'cadence',
            'latlng',
            'watts',
            'watts_calc',
            'grade_adjusted_distance',
            'temp',
        ])
    }]);

    sauce.hist.db.ActivityModel.setSyncManifest('local', [{
        version: 10,
        errorBackoff: 3600 * 1000,
        data: activeStreamProcessor
    }/*, {
        version: 11,
        errorBackoff: 300 * 1000,
        data: runningWattsProcessor
    }, {
        version: 12,
        errorBackoff: 300 * 1000,
        data: activityStatsProcessor
    }*/]);


    async function activeStreamProcessor({activities, athlete}) {
        const s = Date.now();
        const ids = new Set(Array.from(activities).map(x => x.get('id')));
        const actStreams = new Map();
        if (ids.size > 50) {  // 50 is profile tuned.
            const streams = new Set(['time', 'moving', 'cadence', 'watts', 'distance']);
            const allStreamKeys = await streamsStore.getAllKeysForAthlete(athlete.get('id'));
            const streamKeys = allStreamKeys.filter(([id, stream]) => ids.has(id) && streams.has(stream));
            for (const x of await streamsStore.getMany(streamKeys)) {
                if (!actStreams.has(x.activity)) {
                    actStreams.set(x.activity, {});
                }
                actStreams.get(x.activity)[x.stream] = x.data;
            }
        } else {
            for (const x of ids) {
                actStreams.set(x, await streamsStore.activityStreams(x));
            }
        }
        const activeStreams = [];
        for (const activity of activities) {
            const streams = actStreams.get(activity.get('id'));
            const isTrainer = activity.get('trainer');
            const activeStream = sauce.data.createActiveStream(streams, {isTrainer});
            activeStreams.push({
                activity: activity.get('id'),
                athlete: athlete.get('id'),
                stream: 'active',
                data: activeStream
            });
        }
        await streamsStore.putMany(activeStreams);
        const elapsed = Date.now() - s;
        console.warn(`${Math.round(elapsed / ids.size)}ms / activity for ${ids.size} activities`);
    }


    async function runningWattsProcessor({activities, athlete}) {
        // XXX make batch friendly..
        for (const activity of activities) {
            console.debug("running watts proc " + activity, athlete.get('id'));
            const weight = athlete.getWeightAt(activity.get('ts'));
            if (!weight) {
                throw new Error("No weight for athlete, try later...");
            }
            if (activity.get('basetype') !== 'run' || !weight) {
                return;
            }
            const streams = await streamsStore.activityStreams(activity.get('id'));
            const gap = streams.grade_adjusted_distance;
            if (!gap) {
                return;
            }
            const wattsStream = [0];
            for (let i = 1; i < gap.length; i++) {
                const dist = gap[i] - gap[i - 1];
                const time = streams.time[i] - streams.time[i - 1];
                const kj = sauce.pace.work(weight, dist);
                wattsStream.push(kj * 1000 / time);
            }
            await streamsStore.put({
                activity: activity.get('id'),
                athlete: athlete.get('id'),
                stream: 'watts_calc',
                data: wattsStream
            });
        }
    }


    async function activityStatsProcessor({activities, athlete}) {
        // XXX make batch friendly..
        for (const activity of activities) {
            console.debug("stats proc " + activity, athlete.get('id'));
            const ftp = athlete.getFTPAt(activity.get('ts'));
            if (!ftp) {
                throw new Error("No FTP for athlete, try TSS calc later...");
            }
            const streams = await streamsStore.activityStreams(activity.get('id'));
            const stats = {};
            if (streams.watts || (streams.watts_calc && activity.get('basetype') === 'run')) {
                const corrected = sauce.power.correctedPower(streams.time, streams.watts || streams.watts_calc);
                const activeTime = sauce.data.activeTime(streams.time, streams.active);
                stats.kj = corrected.kj();
                stats.power = stats.kj * 1000 / activeTime;
                stats.np = corrected.np();
                stats.xp = corrected.xp();
                stats.tss = sauce.power.calcTSS(stats.np || stats.power, activeTime, ftp);
                stats.intensity = (stats.np || stats.power) / ftp;
            } else if (streams.heartrate) {
                if (athlete.get('hrZones') === undefined) {
                    console.info("Getting HR zones for: " + athlete);
                    athlete.set('hrZones', await sauce.perf.fetchHRZones(athlete.get('id')) || null);
                }
                const zones = athlete.get('hrZones');
                if (zones) {
                    const ltHR = (zones.z4 + zones.z3) / 2;
                    const maxHR = sauce.perf.estimateMaxHR(zones);
                    const restingHR = ftp ? sauce.perf.estimateRestingHR(ftp) : 60;
                    stats.tTss = sauce.perf.tTSS(streams.heartrate, streams.time, streams.active,
                        ltHR, restingHR, maxHR, athlete.get('gender')); // XXX get gender wired in.
                }
            }
            await athlete.save({stats});
        }
    }


    class FetchError extends Error {
        static fromResp(resp) {
            const msg = `${this.name}: ${resp.url} [${resp.status}]`;
            const instance = new this(msg);
            instance.resp = resp;
            return instance;
        }
    }

    class ThrottledFetchError extends FetchError {}


    async function sleep(ms) {
        await new Promise(resolve => setTimeout(resolve, ms));
    }


    async function retryFetch(urn, options={}) {
        const maxRetries = 5;
        const headers = options.headers || {};
        headers["x-requested-with"] = "XMLHttpRequest";  // Required for most Strava endpoints
        const url = `https://www.strava.com${urn}`;
        for (let r = 1;; r++) {
            const resp = await fetch(url, Object.assign({headers}, options));
            if (resp.ok) {
                return resp;
            }
            if (resp.status >= 500 && resp.status < 600 && r <= maxRetries) {
                console.info(`Server error for: ${resp.url} - Retry: ${r}/${maxRetries}`);
                await sleep(1000 * r);
                continue;
            }
            if (resp.status === 429) {
                throw ThrottledFetchError.fromResp(resp);
            }
            throw FetchError.fromResp(resp);
        }
    }


    class SauceRateLimiter extends jobs.RateLimiter {
        async getState() {
            const storeKey = `hist-rate-limiter-${this.label}`;
            return await sauce.storage.get(storeKey);
        }

        async setState(state) {
            const storeKey = `hist-rate-limiter-${this.label}`;
            await sauce.storage.set(storeKey, state);
        }
    }


    // We must stay within API limits;  Roughly 40/min, 300/hour and 1000/day...
    let streamRateLimiterGroup;
    const getStreamRateLimiterGroup = (function() {
        return function() {
            if (!streamRateLimiterGroup) {
                const g = new jobs.RateLimiterGroup();
                g.push(new SauceRateLimiter('streams-min', {period: (60 + 5) * 1000, limit: 30, spread: true}));
                g.push(new SauceRateLimiter('streams-hour', {period: (3600 + 500) * 1000, limit: 200}));
                g.push(new SauceRateLimiter('streams-day', {period: (86400 + 3600) * 1000, limit: 700}));
                streamRateLimiterGroup = g;
            }
            return streamRateLimiterGroup;
        };
    })();


    async function incrementStreamsUsage() {
        // Used for pages to indicate they used the streams API.  This helps
        // keep us on top of overall stream usage better to avoid throttling.
        const g = getStreamRateLimiterGroup();
        await g.increment();
    }
    sauce.proxy.export(incrementStreamsUsage, {namespace});


    function getBaseType(activity) {
        if (activity.type.match(/Ride/)) {
            return 'ride';
        } else if (activity.type.match(/Run|Hike|Walk/)) {
            return 'run';
        } else if (activity.type.match(/Swim/)) {
            return 'swim';
        }
    }


    async function syncSelfActivities(athlete, options={}) {
        const activities = await actsStore.getAllForAthlete(athlete);
        const localIds = new Set(activities.map(x => x.id));
        for (let concurrency = 1, page = 1, pageCount, total;; concurrency = Math.min(concurrency * 2, 25)) {
            const work = new jobs.UnorderedWorkQueue({maxPending: 25});
            for (let i = 0; page === 1 || page <= pageCount && i < concurrency; page++, i++) {
                await work.put((async () => {
                    const q = new URLSearchParams();
                    q.set('new_activity_only', 'false');
                    q.set('page', page);
                    const resp = await retryFetch(`/athlete/training_activities?${q}`);
                    return await resp.json();
                })());
            }
            if (!work.pending() && !work.fulfilled()) {
                break;
            }
            const adding = [];
            for await (const data of work) {
                if (total === undefined) {
                    total = data.total;
                    pageCount = Math.ceil(total / data.perPage);
                }
                for (const x of data.models) {
                    if (!localIds.has(x.id)) {
                        const record = Object.assign({
                            athlete,
                            ts: x.start_date_local_raw * 1000
                        }, x);
                        record.basetype = getBaseType(record);
                        adding.push(record);
                        activities.push(record);  // Sort later.
                    }
                }
            }
            // Don't give up until we've met or exceeded the indicated number of acts.
            // If a user has deleted acts that we previously fetched our count will
            // be higher.  So we also require than the entire work group had no effect
            // before stopping.
            if (adding.length) {
                await actsStore.putMany(adding);
                console.info(`Found ${adding.length} new activities`);
            } else if (activities.length >= total) {
                break;
            }
        }
        activities.sort((a, b) => b.ts - a.ts);
        return activities;
    }


    async function syncPeerActivities(athlete, options={}) {
        const activities = await actsStore.getAllForAthlete(athlete);
        const knownIds = new Set(activities.map(x => x.id));

        function *yearMonthRange(date) {
            for (let year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;; year--, month=12) {
                for (let m = month; m; m--) {
                    yield [year, m];
                }
            }
        }

        async function fetchMonth(year, month) {
            // Welcome to hell.  It gets really ugly in here in an effort to avoid
            // any eval usage which is required to render this HTML into a DOM node.
            // So are doing horrible HTML parsing with regexps..
            const q = new URLSearchParams();
            q.set('interval_type', 'month');
            q.set('chart_type', 'miles');
            q.set('year_offset', '0');
            q.set('interval', '' + year +  month.toString().padStart(2, '0'));
            const resp = await retryFetch(`/athletes/${athlete}/interval?${q}`);
            const data = await resp.text();
            const raw = data.match(/jQuery\('#interval-rides'\)\.html\((.*)\)/)[1];
            const batch = [];
            const activityIconMap = {
                'icon-run': 'run',
                'icon-hike': 'run',
                'icon-walk': 'run',
                'icon-ride': 'ride',
                'icon-virtualride': 'ride',
                'icon-swim': 'swim',
                'icon-alpineski': 'ski',
                'icon-nordicski': 'ski',
                'icon-backcountryski': 'ski',
                'icon-ebikeride': 'ebike',
                'icon-workout': 'workout',
                'icon-standuppaddling': 'workout',
                'icon-yoga': 'workout',
                'icon-snowshoe': 'workout',
            };
            const attrSep = String.raw`(?: |\\"|\\')`;
            function tagWithAttrValue(tag, attrVal, matchVal) {
                return `<${tag} [^>]*?${attrSep}${matchVal ? '(' : ''}${attrVal}${matchVal ? ')' : ''}${attrSep}`;
            }
            const iconRegexps = [];
            for (const key of Object.keys(activityIconMap)) {
                iconRegexps.push(new RegExp(tagWithAttrValue('span', key, true)));
            }
            const feedEntryExp = tagWithAttrValue('div', 'feed-entry');
            const subEntryExp = tagWithAttrValue('li', 'feed-entry');
            const feedEntryRegexp = new RegExp(`(${feedEntryExp}.*?)(?=${feedEntryExp}|$)`, 'g');
            const subEntryRegexp = new RegExp(`(${subEntryExp}.*?)(?=${subEntryExp}|$)`, 'g');
            const activityRegexp = new RegExp(`^[^>]*?${attrSep}activity${attrSep}`);
            const groupActivityRegexp = new RegExp(`^[^>]*?${attrSep}group-activity${attrSep}`);
            for (const [, entry] of raw.matchAll(feedEntryRegexp)) {
                let isGroup;
                if (!entry.match(activityRegexp)) {
                    if (entry.match(groupActivityRegexp)) {
                        isGroup = true;
                    } else {
                        continue;
                    }
                }
                let basetype;
                for (const x of iconRegexps) {
                    const m = entry.match(x);
                    if (m) {
                        basetype = activityIconMap[m[1]];
                        break;
                    }
                }
                if (!basetype) {
                    console.error("Unhandled activity type for:", entry);
                    debugger;
                    basetype = 'workout'; // XXX later this is probably fine to assume.
                }
                let ts;
                const dateM = entry.match(/<time [^>]*?datetime=\\'(.*?)\\'/);
                if (dateM) {
                    const isoDate = dateM[1].replace(/ UTC$/, 'Z').replace(/ /, 'T');
                    ts = (new Date(isoDate)).getTime();
                }
                if (!ts) {
                    console.error("Unable to get timestamp from feed entry");
                    debugger;
                    ts = (new Date(`${year}-${month}`)).getTime(); // Just an approximate value for sync.
                }
                let idMatch;
                if (isGroup) {
                    for (const [, subEntry] of entry.matchAll(subEntryRegexp)) {
                        const athleteM = subEntry.match(/<a [^>]*?entry-athlete[^>]*? href=\\'\/(?:athletes|pros)\/([0-9]+)\\'/);
                        if (!athleteM) {
                            console.error("Unable to get athlete ID from feed sub entry");
                            debugger;
                            continue;
                        }
                        if (Number(athleteM[1]) !== athlete) {
                            console.warn("Skipping activity from other athlete");
                            continue;
                        }
                        idMatch = subEntry.match(/id=\\'Activity-([0-9]+)\\'/);
                        break;
                    }
                    if (!idMatch) {
                        console.error("Group activity parser failed to find activity for this athlete");
                        debugger;
                        continue;
                    }
                } else {
                    idMatch = entry.match(/id=\\'Activity-([0-9]+)\\'/);
                }
                if (!idMatch) {
                    console.error("Unable to get activity ID feed entry");
                    debugger;
                    continue;
                }
                const id = Number(idMatch[1]);
                batch.push({
                    id,
                    ts,
                    basetype,
                    athlete,
                });
            }
            return batch;
        }

        async function batchImport(startDate) {
            const minEmpty = 12;
            const minRedundant = 2;
            const iter = yearMonthRange(startDate);
            for (let concurrency = 1;; concurrency = Math.min(25, concurrency * 2)) {
                const work = new jobs.UnorderedWorkQueue({maxPending: 25});
                for (let i = 0; i < concurrency; i++) {
                    const [year, month] = iter.next().value;
                    await work.put(fetchMonth(year, month));
                }
                let empty = 0;
                let redundant = 0;
                const adding = [];
                for await (const data of work) {
                    if (!data.length) {
                        empty++;
                        continue;
                    }
                    let foundNew;
                    for (const x of data) {
                        if (!knownIds.has(x.id)) {
                            adding.push(x);
                            activities.push(x);  // Sort later.
                            knownIds.add(x.id);
                            foundNew = true;
                        }
                    }
                    if (!foundNew) {
                        redundant++;
                    }
                }
                if (adding.length) {
                    await actsStore.putMany(adding);
                    console.info(`Found ${adding.length} new activities`);
                } else if (empty >= minEmpty && empty >= Math.floor(concurrency)) {
                    const [year, month] = iter.next().value;
                    const date = new Date(`${month === 12 ? year + 1 : year}-${month === 12 ? 1 : month + 1}`);
                    await actsStore.put({id: -athlete, sentinel: date.getTime()});
                    break;
                } else if (redundant >= minRedundant  && redundant >= Math.floor(concurrency)) {
                    // Entire work set was redundant.  Don't refetch any more.
                    break;
                }
            }
        }

        // Fetch latest activities (or all of them if this is the first time).
        await batchImport(new Date());
        // Sentinel is stashed as a special record to indicate that we have scanned
        // some distance into the past.  Without this we never know how far back
        // we looked given there is no page count or total to work with.
        const sentinel = await actsStore.get(-athlete);
        if (!sentinel) {
            // We never finished a prior sync so find where we left off..
            const last = await actsStore.firstForAthlete(athlete);
            await batchImport(new Date(last.ts));
        }
        activities.sort((a, b) => b.ts - a.ts);
        return activities;
    }


    async function fetchStreams(activity, {cancelEvent}) {
        const q = new URLSearchParams();
        for (const m of sauce.hist.db.ActivityModel.getSyncManifest('streams')) {
            for (const x of m.data) {
                q.append('stream_types[]', x);
            }
        }
        const rateLimiters = getStreamRateLimiterGroup();
        for (let i = 1;; i++) {
            if (cancelEvent) {
                await Promise.race([rateLimiters.wait(), cancelEvent.wait()]);
                if (cancelEvent.isSet()) {
                    return;
                }
            } else {
                await rateLimiters.wait();
            }
            console.group(`Fetching streams for: ${activity.get('id')} ${new Date(activity.get('ts'))}`);
            for (const x of rateLimiters) {
                console.debug('' + x);
            }
            console.groupEnd();
            try {
                const resp = await retryFetch(`/activities/${activity.get('id')}/streams?${q}`);
                return await resp.json();
            } catch(e) {
                if (!e.resp) {
                    throw e;
                } else if (e.resp.status === 404) {
                    return null;
                } else if (e.resp.status === 429) {
                    const delay = 60000 * i;
                    console.warn(`Hit Throttle Limits: Delaying next request for ${Math.round(delay / 1000)}s`);
                    if (cancelEvent) {
                        await Promise.race([sleep(delay), cancelEvent.wait()]);
                        if (cancelEvent.isSet()) {
                            return;
                        }
                    } else {
                        await sleep(delay);
                    }
                    console.info("Resuming after throttle period");
                    continue;
                } else {
                    throw e;
                }
            }
        }
    }


    async function syncData(athlete, options={}) {
        const filter = c => !c.value.noStreams;
        const activities = await actsStore.getAllForAthlete(athlete.get('id'), {filter, models: true});
        const unfetched = new Map(activities.map(x => [x.get('id'), x]));
        for await (const id of streamsStore.activitiesByAthlete(athlete.get('id'))) {
            const a = unfetched.get(id);
            if (a && a.isSyncLatest('streams')) {
                unfetched.delete(id);
            }
        }
        const procQueue = new queues.Queue();
        for (const a of activities) {
            const needsFetch = unfetched.has(a.get('id'));
            if (needsFetch && !a.nextSync('streams')) {
                console.warn(`Deferring streams fetch of ${a.get('id')} due to recent error`);
                unfetched.delete(a.get('id'));
            } else if (!needsFetch && !a.isSyncLatest('local')) {
                if (!a.nextSync('local')) {
                    console.warn(`Deferring local processing of ${a.get('id')} due to recent error`);
                } else {
                    procQueue.putNoWait(a);
                }
            }
        }
        const workers = [];
        if (unfetched.size) {
            workers.push(fetchStreamsWorker(procQueue, [...unfetched.values()], athlete, options));
        } else if (!procQueue.qsize()) {
            console.debug("No activity sync required for: " + athlete);
            return;
        } else {
            procQueue.putNoWait(null);  // sentinel
        }
        workers.push(localProcessWorker(procQueue, athlete, options));
        await Promise.all(workers);
        console.debug("Activity sync completed for: " + athlete);
    }


    async function fetchStreamsWorker(procQueue, ...args) {
        try {
            return await _fetchStreamsWorker(procQueue, ...args);
        } finally {
            procQueue.putNoWait(null);
        }
    }


    async function _fetchStreamsWorker(procQueue, activities, athlete, options={}) {
        const cancelEvent = options.cancelEvent;
        for (const activity of activities) {
            let error;
            let data;
            try {
                data = await fetchStreams(activity, {cancelEvent});
            } catch(e) {
                console.warn("Fetch streams error (will retry later):", e);
                error = e;
            }
            if (cancelEvent.isSet()) {
                console.warn('Sync streams cancelled');
                return;
            }
            if (data) {
                await streamsStore.putMany(Object.entries(data).map(([stream, data]) => ({
                    activity: activity.get('id'),
                    athlete: athlete.get('id'),
                    stream,
                    data
                })));
                activity.setSyncVersionLatest('streams');
                procQueue.putNoWait(activity);
            } else if (data === null) {
                activity.set('noStreams', true);
            } else if (error) {
                // Often this is an activity converted to private.
                activity.setSyncError('streams', error);
            }
            await activity.save();
            if (options.onStreams) {
                await options.onStreams({activity, data, error});
            }
        }
        console.info("Completed streams fetch for: " + athlete);
    }


    async function localProcessWorker(q, athlete, options={}) {
        const cancelEvent = options.cancelEvent;
        let done = false;
        const complete = new Set();
        const incomplete = new Set();
        while (!done && !cancelEvent.isSet()) {
            const batch = new Set();
            while (q.qsize()) {
                const a = q.getNoWait();
                if (a === null) {
                    done = true;
                    break;
                }
                batch.add(a);
                if (batch.size >= 1000) {
                    break;
                }
            }
            if (!batch.size && !done) {
                // For handling single items coming off the streams fetch worker...
                const a = await Promise.race([q.get(), cancelEvent.wait()]);
                if (a === null) {
                    done = true;
                } else if (!cancelEvent.isSet()) {
                    batch.add(a);
                }
            }
            while (batch.size && !cancelEvent.isSet()) {
                const versionedBatches = new Map();
                for (const a of batch) {
                    const m = a.nextSync('local');
                    if (!m) {
                        if (!a.isSyncLatest('local')) {
                            console.warn(`Deferring local processing of ${a} due to recent error`);
                            incomplete.add(a);
                        } else {
                            complete.add(a);
                        }
                        batch.delete(a);
                        continue;
                    }
                    if (!versionedBatches.has(m)) {
                        versionedBatches.set(m, new Set());
                    }
                    versionedBatches.get(m).add(a);
                }
                for (const [m, activities] of versionedBatches.entries()) {
                    const fn = m.data;
                    for (const a of activities) {
                        a.clearSyncError('local');
                    }
                    try {
                        console.debug(`Local processing (${fn.name}) v${m.version} on ${activities.size} activities`);
                        await fn({activities, athlete});
                    } catch(e) {
                        // This is a fallback, we would prefer that the processor func handles errors.
                        console.error("Top level local processing error [FIXME]:", fn.name, m.version, e);
                        for (const a of activities) {
                            a.setSyncError('local', e);
                        }
                        debugger;
                    }
                    for (const a of activities) {
                        if (!a.hasSyncError('local')) {
                            a.setSyncVersion('local', m.version);
                        }
                    }
                    await actsStore.saveModels(activities);
                }
            }
            if (complete.size + incomplete.size && options.onLocalProcessing) {
                await options.onLocalProcessing({complete, incomplete, athlete});
            }
        }
    }


    class WorkerPoolExecutor {
        constructor(url, options={}) {
            this.url = url;
            this.maxWorkers = options.maxWorkers || (navigator.hardwareConcurrency * 2);
            this._idle = new queues.Queue();
            this._busy = new Set();
            this._id = 0;
        }

        async _getWorker() {
            let worker;
            if (!this._idle.qsize()) {
                if (this._busy.size >= this.maxWorkers) {
                    console.warn("Waiting for available worker...");
                    worker = await this._idle.get();
                } else {
                    worker = new Worker(this.url);
                }
            } else {
                worker = await this._idle.get();
            }
            if (worker.dead) {
                return await this._getWorker();
            }
            if (worker.gcTimeout) {
                clearTimeout(worker.gcTimeout);
            }
            this._busy.add(worker);
            return worker;
        }

        async exec(call, ...args) {
            const id = this._id++;
            const f = new futures.Future();
            const onMessage = ev => {
                if (!ev.data || ev.data.id == null) {
                    f.setError(new Error("Invalid Worker Message"));
                } else if (ev.data.id !== id) {
                    console.warn('Ignoring worker message from other job');
                    return;
                } else {
                    if (ev.data.success) {
                        f.setResult(ev.data.value);
                    } else {
                        f.setError(ev.data.value);
                    }
                }
            };
            const worker = await this._getWorker();
            worker.addEventListener('message', onMessage);
            try {
                worker.postMessage({call, args, id});
                return await f;
            } finally {
                worker.removeEventListener('message', onMessage);
                this._busy.delete(worker);
                worker.gcTimeout = setTimeout(() => {
                    worker.dead = true;
                    worker.terminate();
                }, 30000);
                this._idle.put(worker);
            }
        }
    }

    const workerPool = new WorkerPoolExecutor(extUrl + 'src/bg/hist-worker.js');


    async function findPeaks(...args) {
        const s = Date.now();
        const result = await workerPool.exec('findPeaks', ...args);
        console.debug('Done: took', Date.now() - s);
        return result;
    }
    sauce.proxy.export(findPeaks, {namespace});


    async function bulkTSS(...args) {
        const s = Date.now();
        const result = await workerPool.exec('bulkTSS', ...args);
        console.debug('Done: took', Date.now() - s);
        return result;
    }
    sauce.proxy.export(bulkTSS, {namespace});


    function download(blob, name) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.style.display = 'none';
        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            link.remove();
            URL.revokeObjectURL(link.href);
        }
    }


    async function exportStreams(name, athlete) {
        name = name || 'streams-export';
        const entriesPerFile = 5000;  // Blob and JSON.stringify have arbitrary limits.
        const batch = [];
        let page = 0;
        function dl(data) {
            const blob = new Blob([JSON.stringify(data)]);
            download(blob, `${name}-${page++}.json`);
        }
        const iter = athlete ? streamsStore.byAthlete(athlete) : streamsStore.values();
        for await (const x of iter) {
            batch.push(x);
            if (batch.length === entriesPerFile) {
                dl(batch);
                batch.length = 0;
            }
        }
        if (batch.length) {
            dl(batch);
        }
        console.info("Export done");
    }
    sauce.proxy.export(exportStreams, {namespace});


    async function importStreams(name='streams-export', host='http://localhost:8001') {
        let added = 0;
        for (let i = 0;; i++) {
            const url = host + `/${name}-${i}.json`;
            const resp = await fetch(url);
            if (!resp.ok) {
                if (resp.status === 404) {
                    break;
                }
                throw new Error('HTTP Error: ' + resp.status);
            }
            const data = await resp.json();
            added += data.length;
            await streamsStore.putMany(data);
            console.info(`Imported ${data.length} from:`, url);
        }
        console.info(`Imported ${added} entries in total.`);
    }
    sauce.proxy.export(importStreams, {namespace});


    async function getSelfFTPs() {
        const resp = await fetch("https://www.strava.com/settings/performance");
        const raw = await resp.text();
        const table = [];
        if (raw) {
            const encoded = raw.match(/all_ftps = (\[.*\]);/);
            if (encoded) {
                for (const x of JSON.parse(encoded[1])) {
                    table.push({ts: x.start_date * 1000, value: x.value});
                }
            }
        }
        return table;
    }


    async function getAthlete(id) {
        return await athletesStore.get(id);
    }
    sauce.proxy.export(getAthlete, {namespace});


    async function isAthleteSyncActive(id) {
        const athlete = await athletesStore.get(id, {model: true});
        return !!(ns.syncManager && ns.syncManager.isActive(athlete));
    }
    sauce.proxy.export(isAthleteSyncActive, {namespace});


    async function invalidateSyncState(athleteId, name) {
        if (!athleteId || !name) {
            throw new TypeError('athleteId and name are required args');
        }
        const activities = await actsStore.getAllForAthlete(athleteId);
        for (const a of activities) {
            if (a.syncState) {
                delete a.syncState[name];
            }
        }
        await actsStore.updateMany(activities.map(x => ({id: x.id, syncState: x.syncState})));
        if (ns.syncManager) {
            await ns.syncManager.enableAthlete(athleteId); // Reset sync state
        }
        return activities.length;
    }


    class SyncJob extends EventTarget {
        constructor(athlete, isSelf) {
            super();
            this.athlete = athlete;
            this.isSelf = isSelf;
            this.status = 'init';
            this._cancelEvent = new locks.Event();
        }

        run() {
            this._runPromise = this._run();
        }

        async wait() {
            await this._runPromise;
        }

        cancel() {
            this._cancelEvent.set();
        }

        cancelled() {
            return this._cancelEvent.isSet();
        }

        async _run() {
            this.status = 'activities-scan';
            const syncFn = this.isSelf ? ns.syncSelfActivities : ns.syncPeerActivities;
            await syncFn(this.athlete.get('id'));
            this.status = 'streams-sync';
            try {
                if (Math.random() > 0.98) { // XXX
                    throw new Error("Random Error");
                }
                await syncData(this.athlete, {
                    cancelEvent: this._cancelEvent,
                    onStreams: this._onStreams.bind(this),
                    onLocalProcessing: this._onLocalProcessing.bind(this),
                });
            } catch(e) {
                this.status = 'error';
                throw e;
            }
            this.status = 'complete';
        }

        _onStreams(data) {
            const ev = new Event('streams');
            ev.data = data;
            this.dispatchEvent(ev);
        }

        _onLocalProcessing(data) {
            const ev = new Event('local');
            ev.data = data;
            this.dispatchEvent(ev);
        }
    }


    class SyncManager extends EventTarget {
        constructor(currentUser) {
            super();
            console.info(`Starting Sync Manager for:`, currentUser);
            //this.refreshInterval = 12 * 3600 * 1000;  // Or shorter with user intervention
            this.refreshInterval = 120 * 1000;  // XXX
            //this.refreshErrorBackoff = 1 * 3600 * 1000;
            this.refreshErrorBackoff = 60 * 1000; // XXX
            this.currentUser = currentUser;
            this._stopping = false;
            this._activeJobs = new Map();
            this._athleteLock = new locks.Lock();
            this._refreshRequests = new Set();
            this._refreshEvent = new locks.Event();
            this._refreshLoop = this.refreshLoop();
            this._importAthleteFTPHistory();
        }

        stop() {
            this._stopping = true;
            for (const x of this._activeJobs.values()) {
                x.cancel();
            }
            this._refreshEvent.set();
        }

        async join() {
            await Promise.allSettled(Array.from(this._activeJobs.values()).map(x => x.wait()));
            await this._refreshLoop;
        }

        async refreshLoop() {
            let errorBackoff = 1000;
            while (!this._stopping) {
                try {
                    await this._refresh();
                } catch(e) {
                    console.error('SyncManager refresh error:', e);
                    sauce.report.error(e);
                    await sleep(errorBackoff *= 1.5);
                }
                this._refreshEvent.clear();
                const enabledAthletes = await athletesStore.getEnabledAthletes({models: true});
                if (!enabledAthletes.length) {
                    console.debug('No athletes enabled for sync.');
                    await this._refreshEvent.wait();
                } else {
                    let oldest = -1;
                    const now = Date.now();
                    for (const athlete of enabledAthletes) {
                        if (this.isActive(athlete) || this._isDeferred(athlete)) {
                            continue;
                        }
                        const age = now - athlete.get('lastSync');
                        oldest = Math.max(age, oldest);
                    }
                    if (oldest === -1) {
                        await this._refreshEvent.wait();
                    } else {
                        const deadline = this.refreshInterval - oldest;
                        console.debug(`Next Sync Manager refresh in ${Math.round(deadline / 1000)} seconds`);
                        await Promise.race([sleep(deadline), this._refreshEvent.wait()]);
                    }
                }
            }
        }

        async _refresh() {
            for (const athlete of await athletesStore.getEnabledAthletes({models: true})) {
                if (this.isActive(athlete)) {
                    continue;
                }
                const now = Date.now();
                if ((now - athlete.get('lastSync') > this.refreshInterval && !this._isDeferred(athlete)) ||
                    this._refreshRequests.has(athlete.get('id'))) {
                    this._refreshRequests.delete(athlete.get('id'));
                    this.runSyncJob(athlete);  // bg okay
                }
            }
        }

        async _importAthleteFTPHistory() {
            const ftpHistory = await getSelfFTPs();
            await this.updateAthlete(this.currentUser, {ftpHistory});
        }

        isActive(athlete) {
            return this._activeJobs.has(athlete.get('id'));
        }

        _isDeferred(athlete) {
            const lastError = athlete.get('lastError');
            return !!lastError && Date.now() - lastError < this.refreshErrorBackoff;
        }

        async runSyncJob(athlete) {
            const start = Date.now();
            console.debug('Starting sync job for: ' + athlete);
            const athleteId = athlete.get('id');
            const isSelf = this.currentUser === athleteId;
            const syncJob = new SyncJob(athlete, isSelf);
            syncJob.addEventListener('streams', ev => {
                // We try to recover from errors, so just hide them from the user for now.
                if (!ev.data.error) {
                    this.emitForAthlete(athlete, 'progress', {
                        sync: 'streams',
                        activity: ev.data.activity.get('id')
                    });
                }
            });
            syncJob.addEventListener('local', ev => {
                if (ev.data.complete.size) {
                    this.emitForAthlete(athlete, 'progress', {
                        sync: 'local',
                        activities: Array.from(ev.data.complete).map(x => x.get('id'))
                    });
                }
            });
            this.emitForAthlete(athlete, 'start');
            this._activeJobs.set(athleteId, syncJob);
            syncJob.run();
            try {
                await syncJob.wait();
            } catch(e) {
                console.error('Sync error occurred:', e);
                athlete.set('lastError', Date.now());
                this.emitForAthlete(athlete, 'error', syncJob.status);
            } finally {
                athlete.set('lastSync', Date.now());
                await this._athleteLock.acquire();
                try {
                    await athlete.save();
                } finally {
                    this._athleteLock.release();
                }
                this._activeJobs.delete(athleteId);
                this._refreshEvent.set();
                this.emitForAthlete(athlete, 'stop', syncJob.status);
                console.debug(`Sync completed in ${Date.now() - start}ms for: ` + athlete);
            }
        }

        emitForAthlete(athlete, name, data) {
            const ev = new Event(name);
            ev.athlete = athlete.get('id');
            ev.data = data;
            this.dispatchEvent(ev);
        }

        refreshRequest(athleteId) {
            this._refreshRequests.add(athleteId);
            this._refreshEvent.set();
        }

        async updateAthlete(id, obj) {
            await this._athleteLock.acquire();
            try {
                const athlete = await athletesStore.get(id, {model: true});
                if (!athlete) {
                    throw new Error('Athlete not found: ' + id);
                }
                await athlete.save(obj);
            } finally {
                this._athleteLock.release();
            }
        }

        async enableAthlete(id) {
            await this.updateAthlete(id, {sync: DBTrue, lastSync: 0, lastError: 0, syncStatus: 'new'});
            this._refreshEvent.set();
        }

        async disableAthlete(id) {
            await this.updateAthlete(id, {sync: DBFalse});
            if (this._activeJobs.has(id)) {
                const syncJob = this._activeJobs.get(id);
                syncJob.cancel();
            }
            this._refreshEvent.set();
        }

        async purgeAthleteData(athlete) {
            // Obviously use with extreme caution!
            await actsStore.deleteAthlete(athlete);
        }

        rateLimiterResumes() {
            const g = streamRateLimiterGroup;
            if (g && g.sleeping()) {
                return streamRateLimiterGroup.resumes() - Date.now();
            }
        }

        rateLimiterSleeping() {
            const g = streamRateLimiterGroup;
            return g & g.sleeping();
        }

        async fetchedActivities(athlete) {
            const filter = c => c.value.noStreams;
            const foundNoStreams = (await actsStore.getAllForAthlete(athlete, {filter})).length;
            const found = await streamsStore.getCountForAthlete(athlete, 'time');
            return foundNoStreams + found;
        }

        async availableActivities(athlete) {
            return await actsStore.getCountForAthlete(athlete);
        }
    }

    if (self.currentUser) {
        ns.syncManager = new SyncManager(self.currentUser);
    }
    addEventListener('currentUserUpdate', async ev => {
        if (ns.syncManager && ns.syncManager.currentUser !== ev.id) {
            console.warn("Stopping Sync Manager due to user change...");
            ns.syncManager.stop();
            await ns.syncManager.join();
            console.debug("Sync Manager stopped.");
        }
        ns.syncManager = ev.id ? new SyncManager(ev.id) : null;
    });


    class SyncController extends sauce.proxy.Eventing {
        constructor(athleteId) {
            super();
            this.athleteId = athleteId;
            this._syncListeners = [];
            this.setupEventRelay('start');
            this.setupEventRelay('stop');
            this.setupEventRelay('progress');
        }

        delete() {
            for (const [name, listener] of this._syncListeners) {
                const sm = ns.syncManager;
                if (sm) {
                    sm.removeEventListener(name, listener);
                }
            }
            this._syncListeners.length = 0;
        }

        setupEventRelay(name) {
            const listener = ev => {
                if (ev.athlete === this.athleteId) {
                    this.dispatchEvent(ev);
                }
            };
            ns.syncManager.addEventListener(name, listener);
            this._syncListeners.push([name, listener]);
        }
    }
    sauce.proxy.export(SyncController, {namespace});


    return {
        importStreams,
        exportStreams,
        syncSelfActivities,
        syncPeerActivities,
        syncData,
        isAthleteSyncActive,
        invalidateSyncState,
        findPeaks,
        bulkTSS,
        streamsStore,
        actsStore,
        athletesStore,
        SyncManager,
        SyncController,
    };
});
