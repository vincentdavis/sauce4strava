/* global sauce */

sauce.ns('hist.db', async ns => {

    'use strict';

    class HistDatabase extends sauce.db.Database {
        get version() {
            return 7;
        }

        migrate(idb, t, oldVersion, newVersion) {
            if (!oldVersion || oldVersion < 1) {
                let store = idb.createObjectStore("streams", {keyPath: ['activity', 'stream']});
                store.createIndex('activity', 'activity');
                store.createIndex('athlete-stream', ['athlete', 'stream']);
                store = idb.createObjectStore("activities", {keyPath: 'id'});
                store.createIndex('athlete-ts', ['athlete', 'ts']);
            }
            if (oldVersion < 2) {
                const store = t.objectStore("streams");
                store.createIndex('athlete', 'athlete');
            }
            if (oldVersion < 3) {
                const store = t.objectStore("activities");
                store.createIndex('athlete-basetype-ts', ['athlete', 'basetype', 'ts']);
            }
            // Version 4 was deprecated in dev.
            if (oldVersion < 5) {
                const store = idb.createObjectStore("athletes", {keyPath: 'id'});
                store.createIndex('sync', 'sync');
            }
            // Version 6 was deprecated in dev.
            if (oldVersion < 7) {
                // XXX REmove me... ASAP
                // This is just to avoid having to manually update my test clients Remove ASAP
                setTimeout(async () => {
                    const s = new ActivitiesStore();
                    const acts = (await s.getAll()).map(x => new ActivityModel(x, s));
                    for (const x of acts) {
                        x.setSyncVersionLatest('streams');
                    }
                    await s.putMany(acts.map(x => x.data));
                    console.warn("XXX Retrofitted streamsVersion on all activities", acts.length);
                }, 1000);
                // /XXX
            }
        }
    }

    const histDatabase = new HistDatabase('SauceHist');


    class StreamsStore extends sauce.db.DBStore {
        constructor() {
            super(histDatabase, 'streams');
        }

        async *byAthlete(athlete, stream, options={}) {
            let q;
            if (stream != null) {
                options.index = 'athlete-stream';
                q = IDBKeyRange.only([athlete, stream]);
            } else {
                options.index = 'athlete';
                q = IDBKeyRange.only(athlete);
            }
            for await (const x of this.values(q, options)) {
                yield x;
            }
        }

        async *manyByAthlete(athlete, streams, options={}) {
            const buffer = new Map();
            const ready = [];
            let wake;
            function add(v) {
                ready.push(v);
                if (wake) {
                    wake();
                }
            }
            Promise.all(streams.map(async stream => {
                for await (const entry of this.byAthlete(athlete, stream)) {
                    const o = buffer.get(entry.activity);
                    if (o === undefined) {
                        buffer.set(entry.activity, {[stream]: entry.data});
                    } else {
                        o[stream] = entry.data;
                        if (Object.keys(o).length === streams.length) {
                            add({
                                athlete,
                                activity: entry.activity,
                                streams: o
                            });
                            buffer.delete(entry.activity);
                        }
                    }
                }
            })).then(() => add(null));
            while (true) {
                while (ready.length) {
                    const v = ready.shift();
                    if (!v) {
                        return;
                    }
                    yield v;
                }
                await new Promise(resolve => wake = resolve);
            }
        }

        async *activitiesByAthlete(athlete, options={}) {
            // Every real activity has a time stream, so look for just this one.
            const q = IDBKeyRange.only([athlete, 'time']);
            options.index = 'athlete-stream';
            for await (const x of this.keys(q, options)) {
                yield x[0];
            }
        }

        async getCountForAthlete(athlete, stream='time') {
            // Every real activity has a time stream, so look for just this one.
            const q = IDBKeyRange.only([athlete, stream]);
            return await this.count(q, {index: 'athlete-stream'});
        }

        async getAthletes(...args) {
            const athletes = [];
            const q = IDBKeyRange.bound(-Infinity, Infinity);
            for await (const x of this.values(q, {unique: true, index: 'athlete'})) {
                athletes.push(x.athlete);
            }
            return athletes;
        }

        async activityStreams(activity) {
            const data = await this.getAll(activity, {index: 'activity'});
            const obj = {};
            for (const x of data) {
                obj[x.stream] = x.data;
            }
            return obj;
        }

        async getAllKeysForAthlete(athlete, options={}) {
            const q = IDBKeyRange.only(athlete);
            options.index = 'athlete';
            return await this.getAllKeys(q, options);
        }
    }


    class ActivitiesStore extends sauce.db.DBStore {
        constructor() {
            super(histDatabase, 'activities');
        }

        async *byAthlete(athlete, options={}) {
            let q;
            const start = options.start || -Infinity;
            const end = options.end || Infinity;
            if (options.type) {
                q = IDBKeyRange.bound([athlete, options.type, start], [athlete, options.type, end]);
                options.index = 'athlete-basetype-ts';
            } else {
                q = IDBKeyRange.bound([athlete, start], [athlete, end]);
                options.index = 'athlete-ts';
            }
            options.reverse = !options.reverse;  // Go from newest to oldest by default
            for await (const x of this.values(q, options)) {
                yield x;
            }
        }

        async getAllForAthlete(athlete, options={}) {
            const activities = [];
            for await (const x of this.byAthlete(athlete, options)) {
                activities.push(x);
            }
            if (options.models) {
                return activities.map(x => new ActivityModel(x, this));
            } else {
                return activities;
            }
        }

        async getCountForAthlete(athlete) {
            const q = IDBKeyRange.bound([athlete, -Infinity], [athlete, Infinity]);
            return await this.count(q, {index: 'athlete-ts'});
        }

        async firstForAthlete(athlete) {
            const q = IDBKeyRange.bound([athlete, -Infinity], [athlete, Infinity]);
            for await (const x of this.values(q, {index: 'athlete-ts'})) {
                return x;
            }
        }

        async lastForAthlete(athlete) {
            const q = IDBKeyRange.bound([athlete, -Infinity], [athlete, Infinity]);
            for await (const x of this.values(q, {index: 'athlete-ts', direction: 'prev'})) {
                return x;
            }
        }

        async deleteAthlete(athlete) {
            const deletes = [];
            const q = IDBKeyRange.bound([athlete, -Infinity], [athlete, Infinity]);
            for await (const key of this.keys(q, {index: 'athlete-ts'})) {
                deletes.push(key);
            }
            const store = this._getStore('readwrite');
            await Promise.all(deletes.map(k => this._request(store.delete(k))));
            return deletes.length;
        }

        async update(query, updates, options={}) {
            if (!this.db.started) {
                await this.db.start();
            }
            const store = this._getStore('readwrite');
            const ifc = options.index ? store.index(options.index) : store;
            const data = await this._request(ifc.get(query));
            Object.assign(data, updates);
            await this._request(store.put(data));
            return data;
        }

        async saveModels(activities) {
            const updatesDatas = [];
            const updatedSave = new Map();
            for (const a of activities) {
                const updates = {};
                for (const k of a._updated) {
                    updates[k] = a.data[k];
                }
                // Save a copy of the updated set from each model in case we fail.
                updatedSave.set(a, new Set(a._updated));
                a._updated.clear();
            }
            try {
                await this.updateMany(updatesDatas);
            } catch(e) {
                // Restore updated keys before throwing, so future saves of the model
                // might recover and persist their changes.
                for (const [a, saved] of updatedSave.entries()) {
                    for (const x of saved) {
                        a._updated.add(x);
                    }
                }
                throw e;
            }
        }
    }


    class AthletesStore extends sauce.db.DBStore {
        constructor() {
            super(histDatabase, 'athletes');
        }

        async get(id, options={}) {
            const data = await super.get(id);
            if (options.model) {
                return new AthleteModel(data, this);
            } else {
                return data;
            }
        }

        async getEnabledAthletes(options={}) {
            const athletes = [];
            const q = IDBKeyRange.only(1);
            for await (const x of this.values(q, {index: 'sync'})) {
                athletes.push(x);
            }
            if (options.models) {
                return athletes.map(x => new AthleteModel(x, this));
            } else {
                return athletes;
            }
        }
    }


    class Model {
        constructor(data, store) {
            this.data = data;
            this._store = store;
            this._updated = new Set();
        }

        get(key) {
            return this.data[key];
        }

        set(keyOrObj, value) {
            if (value === undefined && typeof keyOrObj === 'object') {
                Object.assing(this.data, keyOrObj);
                for (const k of Object.keys(keyOrObj)) {
                    this._updated.add(k);
                }
            } else {
                this.data[keyOrObj] = value;
                this._updated.add(keyOrObj);
            }
        }

        async save(obj) {
            if (obj) {
                for (const [k, v] of Object.entries(obj)) {
                    this.set(k, v);
                }
            }
            const updates = {};
            for (const k of this._updated) {
                updates[k] = this.data[k];
            }
            this._updated.clear();
            await this._store.update(this.data.id, updates);
        }
    }


    class ActivityModel extends Model {
        static setSyncManifest(name, manifest) {
            if (!this._syncManifests) {
                this._syncManifests = {};
            }
            this._syncManifests[name] = manifest;
        }

        static getSyncManifest(name) {
            return this._syncManifests[name];
        }

        toString() {
            return '' + this.get('id');
        }

        getSyncState(name) {
            return (this.data.syncState && this.data.syncState[name]) || undefined;
        }

        isSyncLatest(name) {
            const m = this.constructor.getSyncManifest(name);
            const latest = m[m.length - 1].version;
            const state = this.getSyncState(name);
            return !!(state && state.version && state.version >= latest);
        }

        nextSync(name) {
            const manifest = this.constructor.getSyncManifest(name);
            if (!manifest || !manifest.length) {
                console.warn('No sync available for empty manifest:', name);
                return;
            }
            const state = this.getSyncState(name);
            if (!state) {
                return manifest[0];
            }
            for (const m of manifest) {
                if (m.version > state.version) {
                    if (state.errorTS && Date.now() - state.errorTS < state.errorCount * m.errorBackoff) {
                        return;  // Unavailable until error backoff expires.
                    } else {
                        return m;
                    }
                }
            }
        }

        shouldSync(name) {
            return !this.isSyncLatest(name) && !!this.nextSync(name);
        }

        setSyncError(name, error) {
            this.data.syncState = this.data.syncState || {};
            const state = this.data.syncState[name] = this.data.syncState[name] || {};
            state.errorCount = (state.errorCount || 0) + 1;
            state.errorTS = Date.now();
            state.errorMessage = error.message;
            this._updated.add('syncState');
        }

        hasSyncError(name) {
            return !!this.errorCount;
        }

        clearSyncError(name) {
            this.data.syncState = this.data.syncState || {};
            const state = this.data.syncState[name] = this.data.syncState[name] || {};
            delete state.errorCount;
            delete state.errorTS;
            delete state.errorMessage;
            this._updated.add('syncState');
        }

        setSyncVersion(name, version) {
            this.data.syncState = this.data.syncState || {};
            const state = this.data.syncState[name] = this.data.syncState[name] || {};
            state.version = version;
            this._updated.add('syncState');
        }

        setSyncVersionLatest(name) {
            const m = this.constructor.getSyncManifest(name);
            const latest = m[m.length - 1].version;
            return this.setSyncVersion(name, latest);
        }
    }


    class AthleteModel extends Model {
        toString() {
            return '' + this.get('id');
        }

        _getHistoryValueAt(key, ts) {
            const values = this.data[key];
            if (values) {
                let v = values[0].value;
                for (const x of this.data[key]) {
                    if (x.ts > ts) {
                        break;
                    }
                    v = x.value;
                }
                return v;
            }
        }

        _setHistoryValueAt(key, value, ts) {
            const values = this.data[key] = this.data[key] || [];
            values.push({ts, value});
            values.sort((a, b) => b.ts - a.ts);
            this.set(key, values);
        }

        getFTPAt(ts) {
            return this._getHistoryValueAt('ftpHistory', ts);
        }

        getWeightAt(ts) {
            return this._getHistoryValueAt('weightHistory', ts);
        }

        setFTPAt(value, ts) {
            return this._setHistoryValueAt('ftpHistory', value, ts);
        }

        setWeightAt(value, ts) {
            return this._setHistoryValueAt('weightHistory', value, ts);
        }
    }


    return {
        HistDatabase,
        ActivitiesStore,
        StreamsStore,
        AthletesStore,
        Model,
        ActivityModel,
        AthleteModel,
    };
});
