/* global importScripts, sauce */

importScripts('/src/common/base.js');
const version = new URLSearchParams(location.search).get('version');
const url = `${location.protocol}//${location.hostname}/`;
self.sauceBaseInit(null, url, {name: 'Sauce Worker', version});
importScripts('/src/bg/hist/db.js');
importScripts('/src/common/lib.js');


class SimpleEvent {
    constructor() {
        this._reset();
    }

    _reset() {
        this._p = new Promise(resolve => {
            this._resolve = resolve;
        });
        this._p.finally(() => this._reset());
    }

    async wait() {
        await this._p;
    }

    set() {
        this._resolve();
    }
}


const streamsStore = sauce.hist.db.StreamsStore.singleton();
const peaksStore = sauce.hist.db.PeaksStore.singleton();


async function getActivitiesStreams(activities, streamsDesc) {
    const streamKeys = [];
    const actStreams = new Map();
    for (const a of activities) {
        const streams = Array.isArray(streamsDesc) ?
            streamsDesc :
            streamsDesc[a.basetype === 'run' ? 'run' : a.basetype === 'ride' ? 'ride' : 'other'];
        for (const stream of streams) {
            streamKeys.push([a.id, stream]);
        }
        actStreams.set(a.id, {});
    }
    for (const x of await streamsStore.getMany(streamKeys, {_skipClone: true, _skipCache: true})) {
        if (x) {
            actStreams.get(x.activity)[x.stream] = x.data;
        }
    }
    return actStreams;
}


class WorkerProcessor {
    static factory(...args) {
        const instance = new this(...args);
        instance.start();
        return instance;
    }

    constructor({id, outgoingPort, incomingPort}) {
        this.id = id;
        this._outgoingPort = outgoingPort;
        this._incomingPort = incomingPort;
        this.stopping = false;
        this.incoming = [];
        this._lastSeq;
        this.wakeEvent = new SimpleEvent();
        incomingPort.addEventListener('message', ev => this._onIncoming(ev.data));
        incomingPort.start();
        outgoingPort.start();  // We don't actually use listeners, but I don't want to forget.
    }

    async _onIncoming({seq, op, data}) {
        if (this._lastSeq && seq - this._lastSeq !== 1) {
            console.error("Worker message is out of sequence", this._lastSeq, seq);
        }
        try {
            if (this.stopping) {
                console.error("Worker recieved message after stop request", {seq, op});
                throw new Error('worker is stopping/stopped');
            }
            await this.__onIncoming({data, op});
            this._incomingPort.postMessage({seq, success: true});
        } catch(e) {
            this._incomingPort.postMessage({seq, success: false, error: e.message});
        }
    }

    async __onIncoming({op, data}) {
        if (op === 'data') {
            for (const x of data) {
                this.incoming.push(x);
                // XXX Wake event surely?
            }
            this.wakeEvent.set();
        } else if (op === 'stop') {
            await this.stop();
        } else {
            throw new Error('Invalid worker channel operation');
        }
    }

    send(data) {
        this._outgoingPort.postMessage(data);
    }

    start() {
        this._procTask = this.runProcessor();
    }

    async stop() {
        if (this.stopping) {
            throw new TypeError('already stopping');
        }
        this.stopping = true;
        this.wakeEvent.set();
        await this._procTask;
    }

    async runProcessor() {
        try {
            await this.processor();
        } finally {
            this.stopping = true;
            this._procTask = null;
        }
    }

    processor() {
        // while ! this.stopping...
    }
}


class FindPeaks extends WorkerProcessor {
    constructor({periods, distances, athlete, ...args}) {
        super(args);
        this.periods = periods;
        this.distances = distances;
        this.useEstWatts = athlete.estCyclingWatts && athlete.estCyclingPeaks;
        this.athlete = athlete;
        this.gender = athlete.gender || 'male';
    }

    async processor() {
        while (!this.stopping) {
            while (this.incoming.length) {
                const batch = this.incoming.splice(0, Infinity);
                const errors = await this.findPeaks(batch);
                this.send({done: batch.map(x => x.id), errors});
            }
            await this.wakeEvent.wait();
        }
    }

    getRankLevel(period, p, wp, weight) {
        const rank = sauce.power.rankLevel(period, p, wp, weight, this.gender);
        if (rank.level > 0) {
            return rank;
        }
    }

    async findPeaks(activities) {
        const actStreams = await getActivitiesStreams(activities, {
            run: ['time', 'active', 'heartrate', 'distance', 'grade_adjusted_distance'],
            ride: ['time', 'active', 'heartrate', 'watts', 'watts_calc'].filter(x =>
                x !== 'watts_calc' || this.useEstWatts),
            other: ['time', 'active', 'heartrate', 'watts'],
        });
        const upPeaks = [];
        const errors = [];
        let ts = Date.now();
        for (const activity of activities) {
            if (Date.now() - ts > 400) {
                // Reduce message ACK latency by defering for one task iteration.
                await sauce.sleep(0);
                ts = Date.now();
            }
            if (activity.peaksExclude) {
                continue;  // cleanup happens in finalizer proc.
            }
            const isRun = activity.basetype === 'run';
            const isRide = activity.basetype === 'ride';
            const streams = actStreams.get(activity.id);
            const addPeak = (a1, a2, a3, a4, extra) => {
                const entry = sauce.peaks.createStoreEntry(a1, a2, a3, a4, streams.time, activity, extra);
                if (entry) {
                    upPeaks.push(entry);
                }
            };
            if (streams.heartrate) {
                try {
                    for (const period of this.periods) {
                        const roll = sauce.data.peakAverage(period, streams.time,
                            streams.heartrate, {active: true, ignoreZeros: true, activeStream: streams.active});
                        if (roll) {
                            addPeak('hr', period, roll.avg(), roll);
                        }
                    }
                } catch(e) {
                    // XXX make this better than a big try/catch
                    console.error(this.id, "Failed to create peaks for: " + activity.id, e);
                    errors.push({activity: activity.id, error: e.message});
                }
            }
            const watts = streams.watts || streams.watts_calc;
            if (watts && isRun) {
                debugger; // How the fuck? XXX
            }
            if (watts && !isRun) { // Runs have their own processor for this.
                const estimate = !streams.watts;
                const weight = sauce.model.getAthleteHistoryValueAt(this.athlete.weightHistory, activity.ts);
                try {
                    for (const period of this.periods) {
                        if (estimate && period < 300) {
                            continue;
                        }
                        const rp = sauce.power.correctedRollingPower(streams.time, period);
                        if (!rp) {
                            continue;
                        }
                        const leadCloneOpts = {inlineXP: false, inlineNP: false};
                        const wrp = (!estimate && period >= 300) ?
                            rp.clone({active: true, inlineNP: true, inlineXP: true}) :
                            undefined;
                        const leaders = {};
                        // Instead of using peakPower, peakNP, we do our own reduction to save
                        // repeative iterations on the same dataset; it's about 50% faster.
                        for (let i = 0; i < streams.time.length; i++) {
                            const t = streams.time[i];
                            const w = watts[i];
                            const a = streams.active[i];
                            rp.add(t, w, a);
                            if (wrp) {
                                wrp.resize();
                            }
                            if (rp.full()) {
                                const power = rp.avg();
                                if (power && (!leaders.power || power >= leaders.power.value)) {
                                    leaders.power = {roll: rp.clone(), value: power, np: wrp && wrp.np()};
                                }
                            }
                            if (wrp && wrp.full()) {
                                const np = wrp.np();
                                if (np && (!leaders.np || np >= leaders.np.value)) {
                                    leaders.np = {roll: wrp.clone(leadCloneOpts), value: np};
                                }
                                const xp = wrp.xp();
                                if (xp && (!leaders.xp || xp >= leaders.xp.value)) {
                                    leaders.xp = {roll: wrp.clone(leadCloneOpts), value: xp};
                                }
                            }
                        }
                        if (leaders.power) {
                            const l = leaders.power;
                            const rankLevel = isRide ? this.getRankLevel(l.roll.active(), l.value, l.np, weight) : undefined;
                            addPeak('power', period, l.value, l.roll, {wp: l.np, estimate, rankLevel});
                        }
                        if (leaders.np) {
                            const l = leaders.np;
                            const np = l.roll.np({external: true});
                            const power = l.roll.avg({active: false});
                            const rankLevel = isRide ? this.getRankLevel(l.roll.active(), power, np, weight) : undefined;
                            addPeak('np', period, np, l.roll, {power, estimate, rankLevel});
                        }
                        if (leaders.xp) {
                            const l = leaders.xp;
                            const xp = l.roll.xp({external: true});
                            const power = l.roll.avg({active: false});
                            const rankLevel = isRide ? this.getRankLevel(l.roll.active(), power, xp, weight) : undefined;
                            addPeak('xp', period, xp, l.roll, {power, estimate, rankLevel});
                        }
                    }
                } catch(e) {
                    // XXX make this better than a big try/catch
                    console.error(this.id, "Failed to create peaks for: " + activity.id, e);
                    errors.push({activity: activity.id, error: e.message});
                }
            }
            if (isRun && streams.distance) {
                try {
                    for (const distance of this.distances) {
                        let roll = sauce.pace.bestPace(distance, streams.time, streams.distance);
                        if (roll) {
                            addPeak('pace', distance, roll.avg(), roll);
                        }
                        if (streams.grade_adjusted_distance) {
                            roll = sauce.pace.bestPace(distance, streams.time, streams.grade_adjusted_distance);
                            if (roll) {
                                addPeak('gap', distance, roll.avg(), roll);
                            }
                        }
                    }
                } catch(e) {
                    // XXX make this better than a big try/catch
                    console.error(this.id, "Failed to create peaks for: " + activity.id, e);
                    errors.push({activity: activity.id, error: e.message});
                }
            }
        }
        await peaksStore.putMany(upPeaks);
        return errors;
    }
}


const processors = new Map(Object.entries({
    "find-peaks": (...args) => FindPeaks.factory(...args),
}));


self.addEventListener('message', async ev => {
    const processor = processors.get(ev.data.processor);
    if (!processor) {
        throw new Error("Invalid Processor");
    }
    await processor(ev.data);
});
