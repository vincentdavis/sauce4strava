/* global sauce, Strava */

sauce.ns('locale', ns => {
    'use strict';

    const metersPerMile = 1609.344;
    const msgCache = new Map();
    const warned = new Set();

    let initialized;
    let hdUnits;


    function warnOnce(msg) {
        if (!warned.has(msg)) {
            warned.add(msg);
            console.warn(msg);
        }
    }


    function _getCacheEntry(args) {
        const hashKey = JSON.stringify(args);
        const entry = {
            hashKey,
            args
        };
        if (!msgCache.has(hashKey)) {
            entry.miss = true;
        } else {
            entry.hit = true;
            entry.value = msgCache.get(hashKey);
        }
        return entry;
    }


    function _formatArgs(args) {
        if (typeof args === 'string') {
            return [args];
        } else {
            return Array.from(args);
        }
    }


    async function getMessage(...args) {
        const entry = _getCacheEntry(_formatArgs(args));
        if (entry.hit) {
            return entry.value;
        } else {
            await sauce.proxy.connected;
            const value = await sauce.locale._getMessage(...args);
            if (!value) {
                warnOnce(`Locale message not found: ${entry.hashKey}`);
            }
            msgCache.set(entry.hashKey, value);
            return value;
        }
    }


    async function getMessages(batch) {
        const missing = [];
        const hashKeys = [];
        for (const args of batch.map(_formatArgs)) {
            const entry = _getCacheEntry(args);
            if (entry.miss) {
                missing.push(entry);
            }
            hashKeys.push(entry.hashKey);
        }
        if (missing.length) {
            await sauce.proxy.connected;
            const values = await sauce.locale._getMessages(missing.map(x => x.args[0]));
            for (let i = 0; i < missing.length; i++) {
                const value = values[i];
                if (!value) {
                    warnOnce(`Locale message not found: ${missing[i].hashKey}`);
                }
                msgCache.set(missing[i].hashKey, value);
            }
        }
        return hashKeys.map(x => msgCache.get(x));
    }


    async function getMessagesObject(keys, ns) {
        const prefix = ns ? `${ns}_` : '';
        const msgs = await getMessages(keys.map(x => `${prefix}${x}`));
        return msgs.reduce((acc, x, i) => (acc[keys[i]] = x, acc), {});
    }


    let _initing;
    async function init() {
        if (initialized) {
            return;
        }
        if (!_initing) {
            _initing = _init();
        }
        await _initing;
    }


    async function _init() {
        const units = ['year', 'week', 'day', 'hour', 'min', 'sec',
                       'years', 'weeks', 'days', 'hours', 'mins', 'secs',
                       'ago', 'now'];
        hdUnits = await getMessagesObject(units, 'time');
        ns.elevationFormatter = new Strava.I18n.ElevationFormatter();
        ns.hrFormatter = new Strava.I18n.HeartRateFormatter();
        ns.tempFormatter = new Strava.I18n.TemperatureFormatter();
        Strava.I18n.FormatterTranslations.swim_cadence = {
            abbr: "%{value} <abbr class='unit short' title='strokes per minute'>spm</abbr>",
            "long": {
                one: "%{count} strokes per minute",
                other: "%{count} strokes per minute"
            },
            "short": "%{value} spm",
            name_long: "strokes per minute",
            name_short: "spm"
        };
        ns.cadenceFormatter = new Strava.I18n.CadenceFormatter();
        ns.cadenceFormatterRun = new Strava.I18n.DoubledStepCadenceFormatter();
        ns.cadenceFormatterSwim = new Strava.I18n.CadenceFormatter();
        ns.cadenceFormatterSwim.key = 'swim_cadence';
        ns.timeFormatter = new Strava.I18n.TimespanFormatter();
        ns.weightFormatter = new Strava.I18n.WeightFormatter();
        ns.distanceFormatter = new Strava.I18n.DistanceFormatter();
        ns.paceFormatter = new Strava.I18n.PaceFormatter();
        ns.speedFormatter = new Strava.I18n.DistancePerTimeFormatter();
        ns.swimPaceFormatter = new Strava.I18n.SwimPaceFormatter;
        initialized = true;
    }


    function assertInit() {
        if (!initialized) {
            throw new TypeError('init() must be called first');
        }
    }


    function getPaceFormatter(type) {
        return {
            swim: ns.swimPaceFormatter,
            speed: ns.speedFormatter,
            pace: ns.paceFormatter
        }[type || 'pace'];
    }


    function humanDuration(elapsed, options={}) {
        assertInit();
        const min = 60;
        const hour = min * 60;
        const day = hour * 24;
        const week = day * 7;
        const year = day * 365;
        const units = [
            ['year', year],
            ['week', week],
            ['day', day],
            ['hour', hour],
            ['min', min],
            ['sec', 1]
        ];
        const stack = [];
        const precision = options.precision || 1;
        elapsed = Math.round(elapsed / precision) * precision;
        for (let [key, period] of units) {
            if (precision > period) {
                break;
            }
            if (elapsed >= period) {
                if (elapsed >= 2 * period) {
                    key += 's';
                }
                const suffix = hdUnits[key];
                stack.push(`${Math.floor(elapsed / period)} ${suffix}`);
                elapsed %= period;
            }
        }
        return stack.slice(0, 2).join(', ');
    }


    function humanTimeAgo(date, options) {
        assertInit();
        const elapsed = (Date.now() - date) / 1000;
        const duration = humanDuration(elapsed, options);
        if (duration) {
            return `${duration} ${hdUnits.ago}`;
        } else {
            return hdUnits.now;
        }
    }


    function humanWeight(kg) {
        return humanNumber(ns.weightFormatter.convert(kg), 1);
    }


    function humanTime(seconds) {
        assertInit();
        return ns.timeFormatter.display(seconds);
    }


    function humanDistance(meters, precision) {
        assertInit();
        return ns.distanceFormatter.format(meters, precision || 2);
    }


    function humanPace(raw, options={}) {
        assertInit();
        const mps = options.velocity ? raw : 1 / raw;
        const formatter = getPaceFormatter(options.type);
        const value = formatter.key === 'distance_per_time' ? mps * 3600 : mps;
        const minPace = 0.1;  // About 4.5 hours / mile
        if (options.suffix) {
            if (options.html) {
                if (value < minPace) {
                    return '<abbr class="unit short" title="Stopped">-</abbr>';
                }
                return formatter.abbreviated(value);
            } else {
                if (value < minPace) {
                    return '-';
                }
                return formatter.formatShort(value);
            }
        } else {
            if (value < minPace) {
                return '-';
            }
            return formatter.format(value);
        }
    }


    function humanNumber(value, precision=0) {
        assertInit();
        if (value == null || value === '') {
            return '';
        }
        const n = Number(value);
        if (isNaN(n)) {
            console.warn("Value is not a number:", value);
            return value;
        }
        if (precision === null) {
            return n.toLocaleString();
        } else if (precision === 0) {
            return Math.round(n).toLocaleString();
        } else {
            return Number(n.toFixed(precision)).toLocaleString();
        }
    }


    function humanElevation(meters, options={}) {
        assertInit();
        if (options.suffix) {
            if (options.longSuffix) {
                return ns.elevationFormatter.formatLong(meters);
            } else {
                return ns.elevationFormatter.formatShort(meters);
            }
        } else {
            return ns.elevationFormatter.format(meters);
        }
    }


    function humanStride(meters) {
        assertInit();
        const metric = ns.weightFormatter.unitSystem === 'metric';
        if (metric) {
            return humanNumber(meters, 2);
        } else {
            const feet = meters / metersPerMile * 5280;
            return humanNumber(feet, 1);
        }
    }


    function weightUnconvert(localeWeight) {
        assertInit();
        return ns.weightFormatter.unitSystem === 'metric' ? localeWeight : localeWeight / 2.20462;
    }


    function elevationUnconvert(localeEl) {
        assertInit();
        return ns.elevationFormatter.unitSystem === 'metric' ? localeEl : localeEl * 0.3048;
    }


    function velocityUnconvert(localeV, options={}) {
        assertInit();
        const f = getPaceFormatter(options.type);
        return (f.unitSystem === 'metric' ? localeV * 1000 : localeV * metersPerMile) / 3600;
    }


    function distanceUnconvert(localeDist) {
        assertInit();
        return ns.distanceFormatter.unitSystem === 'metric' ? localeDist * 1000 : localeDist * metersPerMile;
    }


    return {
        init,
        getMessage,
        getMessages,
        getMessagesObject,
        getPaceFormatter,
        weightUnconvert,
        elevationUnconvert,
        velocityUnconvert,
        distanceUnconvert,
        human: {
            duration: humanDuration,
            timeAgo: humanTimeAgo,
            weight: humanWeight,
            elevation: humanElevation,
            number: humanNumber,
            pace: humanPace,
            distance: humanDistance,
            time: humanTime,
            stride: humanStride,
        },
        templateHelpers: {
            humanDuration,
            humanTimeAgo,
            humanWeight,
            humanElevation,
            humanNumber,
            humanPace,
            humanDistance,
            humanTime,
            humanStride,
        },
    };
});
