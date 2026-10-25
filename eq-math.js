(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DC04UEqMath = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  // Standard RBJ biquads, not a measurement of the DC04U firmware response.
  // Formula source: https://www.w3.org/TR/audio-eq-cookbook/
  const TYPES = Object.freeze(['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch', 'bandpass', 'allpass']);
  const DEVICE_TYPES = Object.freeze({ 1: 'lowshelf', 2: 'peaking', 3: 'highshelf', 4: 'lowpass', 5: 'highpass', 6: 'bandpass', 7: 'allpass' });
  const DEVICE_CODES = Object.freeze({ lowshelf: 1, peaking: 2, highshelf: 3, lowpass: 4, highpass: 5, bandpass: 6, allpass: 7 });
  const DEFAULT_FREQUENCIES = Object.freeze([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  const ALIASES = Object.freeze({ pk: 'peaking', peak: 'peaking', peq: 'peaking', peaking: 'peaking',
    ls: 'lowshelf', lsc: 'lowshelf', lowshelf: 'lowshelf', hs: 'highshelf', hsc: 'highshelf', highshelf: 'highshelf',
    lp: 'lowpass', lpq: 'lowpass', lowpass: 'lowpass', hp: 'highpass', hpq: 'highpass', highpass: 'highpass',
    no: 'notch', notch: 'notch', bp: 'bandpass', bandpass: 'bandpass', ap: 'allpass', allpass: 'allpass' });
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const finite = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite.`);
    return value;
  };

  function normalizeType(type) {
    if (typeof type === 'number') {
      if (type === 0) return 'peaking';
      if (DEVICE_TYPES[type]) return DEVICE_TYPES[type];
    }
    const result = ALIASES[String(type === undefined ? 'peaking' : type).toLowerCase().replace(/[\s_-]/g, '')];
    if (!result) throw new RangeError(`Unsupported filter type: ${type}`);
    return result;
  }

  function normalizeBand(band = {}, index = 0) {
    const type = normalizeType(band.type === undefined ? band.filterType : band.type);
    const frequency = finite(band.frequency === undefined ? DEFAULT_FREQUENCIES[index % 10] : band.frequency, 'Frequency');
    const gain = finite(band.gain === undefined ? 0 : band.gain, 'Gain');
    const q = finite(band.q === undefined ? (band.factor === undefined ? Math.SQRT1_2 : band.factor) : band.q, 'Q');
    if (frequency <= 0 || q <= 0) throw new RangeError('Frequency and Q must be positive.');
    return { frequency, gain, q, type, enabled: band.enabled !== false && band.status !== false && band.type !== 0 && band.filterType !== 0 };
  }

  function normalizePreset(preset = {}, pad = false) {
    const input = Array.isArray(preset) ? preset : (preset.bands || preset.filterSettings || []);
    if (!Array.isArray(input) || input.length > 10) throw new RangeError('DC04U presets may contain at most ten bands.');
    const bands = input.map(normalizeBand);
    if (pad) while (bands.length < 10) bands.push({ frequency: DEFAULT_FREQUENCIES[bands.length], gain: 0, q: Math.SQRT1_2, type: 'peaking', enabled: false });
    const preamp = Array.isArray(preset) ? 0 : finite(preset.preamp === undefined ? (preset.totalGain === undefined ? 0 : preset.totalGain) : preset.preamp, 'Preamp');
    return { name: typeof preset.name === 'string' ? preset.name : 'DC04U Custom', preamp, bands };
  }

  function frequencyGrid(count = 256, minimum = 20, maximum = 20000) {
    if (!Number.isInteger(count) || count < 2 || count > 16384) throw new RangeError('Grid size must be between 2 and 16384.');
    finite(minimum, 'Minimum frequency'); finite(maximum, 'Maximum frequency');
    if (minimum <= 0 || maximum <= minimum) throw new RangeError('A positive increasing frequency range is required.');
    const logMinimum = Math.log(minimum), step = Math.log(maximum / minimum) / (count - 1);
    return Array.from({ length: count }, (_, index) => index === 0 ? minimum : index === count - 1 ? maximum : Math.exp(logMinimum + index * step));
  }

  function biquad(input, sampleRate = 48000) {
    finite(sampleRate, 'Sample rate');
    const band = normalizeBand(input);
    if (sampleRate <= 0 || band.frequency >= sampleRate / 2) throw new RangeError('Filter frequency must be below Nyquist.');
    if (!band.enabled) return { b0: 1, b1: 0, b2: 0, a0: 1, a1: 0, a2: 0 };
    const A = 10 ** (band.gain / 40), omega = 2 * Math.PI * band.frequency / sampleRate;
    const c = Math.cos(omega), s = Math.sin(omega), alpha = s / (2 * band.q);
    let b0, b1, b2, a0, a1, a2;
    switch (band.type) {
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * c; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * c; a2 = 1 - alpha / A; break;
      case 'lowshelf': {
        const beta = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) - (A - 1) * c + beta);
        b1 = 2 * A * ((A - 1) - (A + 1) * c);
        b2 = A * ((A + 1) - (A - 1) * c - beta);
        a0 = (A + 1) + (A - 1) * c + beta;
        a1 = -2 * ((A - 1) + (A + 1) * c);
        a2 = (A + 1) + (A - 1) * c - beta; break;
      }
      case 'highshelf': {
        const beta = 2 * Math.sqrt(A) * alpha;
        b0 = A * ((A + 1) + (A - 1) * c + beta);
        b1 = -2 * A * ((A - 1) + (A + 1) * c);
        b2 = A * ((A + 1) + (A - 1) * c - beta);
        a0 = (A + 1) - (A - 1) * c + beta;
        a1 = 2 * ((A - 1) - (A + 1) * c);
        a2 = (A + 1) - (A - 1) * c - beta; break;
      }
      case 'lowpass': b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
      case 'highpass': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
      case 'notch': b0 = 1; b1 = -2 * c; b2 = 1; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
      case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
      case 'allpass': b0 = 1 - alpha; b1 = -2 * c; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * c; a2 = 1 - alpha; break;
    }
    const coefficients = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a0: 1, a1: a1 / a0, a2: a2 / a0 };
    if (!Object.values(coefficients).every(Number.isFinite)) throw new RangeError('Unstable filter parameters.');
    return coefficients;
  }

  function magnitudeDb(coefficients, frequency, sampleRate) {
    const omega = 2 * Math.PI * frequency / sampleRate;
    const c = Math.cos(omega), s = Math.sin(omega), c2 = Math.cos(2 * omega), s2 = Math.sin(2 * omega);
    const br = coefficients.b0 + coefficients.b1 * c + coefficients.b2 * c2;
    const bi = coefficients.b1 * s + coefficients.b2 * s2;
    const ar = 1 + coefficients.a1 * c + coefficients.a2 * c2;
    const ai = coefficients.a1 * s + coefficients.a2 * s2;
    // A plot floor keeps exact notches and DC/Nyquist zeros finite.
    return 10 * Math.log10(Math.max(1e-30, br * br + bi * bi) / Math.max(1e-30, ar * ar + ai * ai));
  }

  function response(presetOrBands, frequencies = frequencyGrid(), sampleRate = 48000) {
    finite(sampleRate, 'Sample rate');
    if (sampleRate <= 0) throw new RangeError('Sample rate must be positive.');
    const preset = normalizePreset(presetOrBands);
    const grid = Array.from(frequencies);
    grid.forEach(frequency => {
      finite(frequency, 'Response frequency');
      if (frequency < 0 || frequency > sampleRate / 2) throw new RangeError('Response frequencies must lie between DC and Nyquist.');
    });
    const coefficients = preset.bands.filter(band => band.enabled).map(band => biquad(band, sampleRate));
    return grid.map(frequency => coefficients.reduce((db, coefficient) => db + magnitudeDb(coefficient, frequency, sampleRate), preset.preamp));
  }

  function canonicalCurve(input) {
    let points;
    if (Array.isArray(input)) points = input.map(point => Array.isArray(point) ? { frequency: point[0], db: point[1] } :
      { frequency: point.frequency === undefined ? point.f : point.frequency, db: point.db === undefined ? (point.raw === undefined ? point.gain : point.raw) : point.db });
    else if (input && Array.isArray(input.frequency)) {
      const values = input.raw || input.db || input.gain;
      if (!Array.isArray(values) || input.frequency.length !== values.length) throw new RangeError('Curve frequency/value lengths differ.');
      points = input.frequency.map((frequency, index) => ({ frequency, db: values[index] }));
    } else throw new TypeError('A curve must be points or a frequency/raw array pair.');
    for (const point of points) {
      finite(point.frequency, 'Curve frequency'); finite(point.db, 'Curve dB');
      if (point.frequency <= 0) throw new RangeError('Curve frequencies must be positive.');
    }
    points.sort((a, b) => a.frequency - b.frequency);
    const merged = [];
    for (let index = 0; index < points.length;) {
      const frequency = points[index].frequency;
      let sum = 0, count = 0;
      while (index < points.length && points[index].frequency === frequency) { sum += points[index++].db; count++; }
      merged.push({ frequency, db: sum / count });
    }
    if (merged.length < 2) throw new RangeError('A curve needs at least two distinct frequencies.');
    return merged;
  }

  function interpolateCanonical(points, frequency) {
    if (frequency <= points[0].frequency) return points[0].db;
    if (frequency >= points[points.length - 1].frequency) return points[points.length - 1].db;
    let low = 0, high = points.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (points[middle].frequency <= frequency) low = middle; else high = middle;
    }
    const a = points[low], b = points[high];
    const fraction = Math.log(frequency / a.frequency) / Math.log(b.frequency / a.frequency);
    return a.db + fraction * (b.db - a.db);
  }

  function interpolateCurve(curve, frequencies) {
    const points = canonicalCurve(curve);
    return Array.from(frequencies, frequency => {
      finite(frequency, 'Interpolation frequency');
      if (frequency <= 0) throw new RangeError('Interpolation frequencies must be positive.');
      return { frequency, db: interpolateCanonical(points, frequency) };
    });
  }

  function normalizeCurve(curve, reference = 1000) {
    const points = canonicalCurve(curve);
    finite(reference, 'Reference frequency');
    if (reference < points[0].frequency || reference > points[points.length - 1].frequency) throw new RangeError('Normalization reference lies outside the curve.');
    const offset = interpolateCanonical(points, reference);
    return points.map(point => ({ frequency: point.frequency, db: point.db - offset }));
  }

  function targetDifference(measured, target, options = {}) {
    const reference = options.reference === undefined ? 1000 : options.reference;
    const a = options.normalize === false ? canonicalCurve(measured) : normalizeCurve(measured, reference);
    const b = options.normalize === false ? canonicalCurve(target) : normalizeCurve(target, reference);
    const minimum = Math.max(options.minimum || 20, a[0].frequency, b[0].frequency);
    const maximum = Math.min(options.maximum || 20000, a[a.length - 1].frequency, b[b.length - 1].frequency);
    if (maximum <= minimum) throw new RangeError('Measurement and target have no overlapping frequency range.');
    const frequencies = options.frequencies || frequencyGrid(options.count || 256, minimum, maximum);
    return Array.from(frequencies, frequency => {
      if (!Number.isFinite(frequency) || frequency < minimum || frequency > maximum) throw new RangeError('Difference grid lies outside the common measured range.');
      return { frequency, db: interpolateCanonical(b, frequency) - interpolateCanonical(a, frequency) };
    });
  }

  function smoothCurve(curve, octaves = 1 / 3) {
    const points = canonicalCurve(curve);
    finite(octaves, 'Smoothing width');
    if (octaves <= 0) return points;
    const sigma = octaves / 2.355;
    return points.map(point => {
      let total = 0, weights = 0;
      for (const neighbor of points) {
        const distance = Math.log2(neighbor.frequency / point.frequency) / sigma;
        if (Math.abs(distance) > 3) continue;
        const weight = Math.exp(-distance * distance / 2);
        total += neighbor.db * weight; weights += weight;
      }
      return { frequency: point.frequency, db: total / weights };
    });
  }

  function quantizePreset(input) {
    const preset = normalizePreset(input, true);
    return { name: preset.name, preamp: clamp(Math.floor(preset.preamp), -24, 12),
      bands: preset.bands.map(band => ({ ...band,
        frequency: clamp(Math.round(band.frequency), 20, 20000),
        gain: Math.round(clamp(band.gain, -24, 12) * 256) / 256,
        q: Math.round(clamp(band.q, 0.3, 20) * 256) / 256 })) };
  }

  function fit(measured, target, options = {}) {
    const sampleRate = options.sampleRate === undefined ? 48000 : finite(options.sampleRate, 'Sample rate');
    const maximum = Math.min(options.maximum || 16000, sampleRate * 0.475);
    const correction = targetDifference(measured, target, { ...options, maximum, count: options.count || 256 });
    const smoothed = smoothCurve(correction, options.smoothingOctaves === undefined ? 1 / 3 : options.smoothingOctaves);
    const frequencies = smoothed.map(point => point.frequency), desired = smoothed.map(point => point.db);
    const weights = frequencies.map(frequency => (frequency < 35 ? 0.45 : frequency < 60 ? 0.75 : 1) * (frequency > 10000 ? 0.1 : frequency > 8000 ? 0.25 : frequency > 6000 ? 0.5 : 1));
    const weightSum = weights.reduce((sum, value) => sum + value, 0);
    const mean = values => values.reduce((sum, value, index) => sum + value * weights[index], 0) / weightSum;
    const loss = values => { const offset = mean(values); return values.reduce((sum, value, index) => sum + weights[index] * (value - offset) ** 2, 0) / weightSum; };
    const maxGain = clamp(options.maxGain === undefined ? 6 : finite(options.maxGain, 'Maximum boost'), 0.1, 12);
    const minGain = -clamp(options.maxCut === undefined ? 12 : finite(options.maxCut, 'Maximum cut'), 0.1, 24);
    const maxQ = clamp(options.maxQ === undefined ? 4 : finite(options.maxQ, 'Maximum Q'), 0.3, 10);
    const minQ = clamp(options.minQ === undefined ? 0.5 : finite(options.minQ, 'Minimum Q'), 0.3, maxQ);
    const maxFilters = options.maxFilters === undefined ? 10 : options.maxFilters;
    if (!Number.isInteger(maxFilters) || maxFilters < 0 || maxFilters > 10) throw new RangeError('Fit uses zero to ten filters.');
    const candidates = [];
    function addCandidate(frequency, q, type) {
      if (frequency < 20 || frequency > maximum || frequency >= sampleRate / 2) return;
      const band = { frequency, q: clamp(q, minQ, maxQ), type, gain: 3, enabled: true };
      const basis = response([band], frequencies, sampleRate).map(value => value / 3);
      const center = mean(basis);
      const energy = basis.reduce((sum, value, index) => sum + weights[index] * (value - center) ** 2, 0);
      if (energy > 1e-12) candidates.push({ band, basis, center, energy });
    }
    for (let frequency = 25; frequency <= maximum; frequency *= 2 ** 0.25) {
      for (const q of [0.5, Math.SQRT1_2, 1.1, 1.7, 2.7, maxQ]) addCandidate(frequency, q, 'peaking');
    }
    for (const frequency of [60, 100, 150, 250]) addCandidate(frequency, Math.SQRT1_2, 'lowshelf');
    for (const frequency of [3000, 6000, 10000]) addCandidate(frequency, Math.SQRT1_2, 'highshelf');
    const bands = [], traces = [];
    let residual = desired.slice();
    function projectedGain(candidate, values) {
      const offset = mean(values);
      const cross = candidate.basis.reduce((sum, value, index) => sum + weights[index] * (value - candidate.center) * (values[index] - offset), 0);
      return clamp(cross / candidate.energy, minGain, maxGain);
    }
    for (let index = 0; index < maxFilters; index++) {
      const oldLoss = loss(residual);
      if (oldLoss < 0.0025) break;
      const shortlist = candidates.map(candidate => {
        const gain = projectedGain(candidate, residual);
        return { candidate, gain, estimated: loss(residual.map((value, i) => value - candidate.basis[i] * gain)) };
      }).sort((a, b) => a.estimated - b.estimated).slice(0, 12);
      let best = null;
      for (const entry of shortlist) {
        if (Math.abs(entry.gain) < 0.05) continue;
        const band = { ...entry.candidate.band, gain: entry.gain };
        const trace = response([band], frequencies, sampleRate);
        const next = residual.map((value, i) => value - trace[i]);
        const nextLoss = loss(next);
        if (!best || nextLoss < best.loss) best = { band, trace, next, loss: nextLoss };
      }
      if (!best || oldLoss - best.loss < 1e-5) break;
      bands.push(best.band); traces.push(best.trace); residual = best.next;
    }
    // A bounded coordinate refinement improves broad-feature fits without a
    // random seed, high-Q resonances or an unbounded optimization loop.
    for (const step of [1 / 8, 1 / 16, 1 / 32]) {
      for (let index = 0; index < bands.length; index++) {
        const oldBand = bands[index], oldTrace = traces[index];
        const without = residual.map((value, i) => value + oldTrace[i]);
        let best = { band: oldBand, trace: oldTrace, residual, loss: loss(residual) };
        for (const frequencyFactor of [2 ** -step, 1, 2 ** step]) {
          for (const qFactor of [2 ** -step, 1, 2 ** step]) {
            const trial = { ...oldBand, frequency: clamp(oldBand.frequency * frequencyFactor, 20, maximum), q: clamp(oldBand.q * qFactor, minQ, maxQ), gain: 3 };
            const basis = response([trial], frequencies, sampleRate).map(value => value / 3), center = mean(basis);
            const energy = basis.reduce((sum, value, i) => sum + weights[i] * (value - center) ** 2, 0);
            if (energy <= 1e-12) continue;
            const gain = projectedGain({ basis, center, energy }, without);
            const band = { ...trial, gain }, trace = response([band], frequencies, sampleRate);
            const next = without.map((value, i) => value - trace[i]), nextLoss = loss(next);
            if (nextLoss < best.loss) best = { band, trace, residual: next, loss: nextLoss };
          }
        }
        bands[index] = best.band; traces[index] = best.trace; residual = best.residual;
      }
    }
    const preset = quantizePreset({ name: options.name || 'Auto fit · offline preview', bands, preamp: 0 });
    const predicted = response(preset.bands, frequencies, sampleRate);
    const error = desired.map((value, index) => value - predicted[index]);
    const headroomGrid = [0, ...frequencyGrid(2048, 20, Math.min(20000, sampleRate * 0.499)), sampleRate / 2,
      ...preset.bands.filter(band => band.enabled).map(band => band.frequency)];
    const peakBoostDb = Math.max(0, ...response(preset.bands, headroomGrid, sampleRate));
    const margin = options.headroomDb === undefined ? 0.5 : finite(options.headroomDb, 'Headroom');
    preset.preamp = bands.length ? clamp(-Math.ceil(Math.max(0, peakBoostDb + Math.max(0, margin) - 1e-9)), -24, 0) : 0;
    return { ...preset, metrics: { beforeRmse: Math.sqrt(loss(desired)), afterRmse: Math.sqrt(loss(error)),
      alignmentDb: mean(error), peakBoostDb, headroomDeficitDb: Math.max(0, peakBoostDb + preset.preamp),
      sampleRate, fitBandCount: bands.length, pointCount: frequencies.length,
      includesPreamp: false, smoothingOctaves: options.smoothingOctaves === undefined ? 1 / 3 : options.smoothingOctaves },
      correction: smoothed, warning: 'Offline RBJ prediction; device firmware response and measurement rig compatibility must be checked separately.' };
  }

  function parseOfficialJSON(input) {
    const object = typeof input === 'string' ? JSON.parse(input) : input;
    if (!object || !Array.isArray(object.filterSettings) || object.filterSettings.length > 10) throw new TypeError('Expected an official DC04U filterSettings JSON object.');
    const seen = new Set();
    const sorted = object.filterSettings.map((band, index) => {
      const order = band.filterIndex === undefined ? index : band.filterIndex;
      if (!Number.isInteger(order) || order < 0 || order > 9 || seen.has(order)) throw new RangeError('Filter indices must be unique integers from zero to nine.');
      seen.add(order);
      if (!Number.isInteger(band.filterType) || band.filterType < 0 || band.filterType > 7) throw new RangeError('Unknown DC04U numeric filter type.');
      return { ...normalizeBand(band, order), order };
    }).sort((a, b) => a.order - b.order);
    const bands = Array.from({ length: 10 }, (_, index) => {
      const found = sorted.find(band => band.order === index);
      if (found) { const { order, ...band } = found; return band; }
      return { frequency: DEFAULT_FREQUENCIES[index], gain: 0, q: Math.SQRT1_2, type: 'peaking', enabled: false };
    });
    return normalizePreset({ name: object.name, preamp: object.totalGain === undefined ? 0 : object.totalGain, bands }, true);
  }

  function formatOfficialJSON(input, name) {
    const preset = quantizePreset(input);
    const filterSettings = preset.bands.map((band, index) => {
      if (band.enabled && band.type === 'notch') throw new RangeError('DC04U has no verified notch type; numeric type 6 is bandpass.');
      return { filterIndex: index, status: band.enabled, filterType: band.enabled ? DEVICE_CODES[band.type] : 0,
        frequency: band.frequency, gain: band.gain, factor: band.q };
    });
    return JSON.stringify({ name: name || preset.name, description: 'Offline PEQ preset; review before applying to a device.', totalGain: preset.preamp, filterSettings }, null, 2);
  }

  function parseAutoEq(text) {
    if (typeof text !== 'string') throw new TypeError('AutoEq text must be a string.');
    const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?';
    let preamp = 0;
    const bands = [];
    for (const original of text.split(/\r?\n/)) {
      const line = original.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const pre = line.match(new RegExp(`^Preamp:\\s*(${number})\\s*dB\\s*$`, 'i'));
      if (pre) { preamp = Number(pre[1]); continue; }
      const filter = line.match(/^Filter\s+\d+\s*:\s*(ON|OFF)\s+([a-z]+)\b(.*)$/i);
      if (!filter) throw new SyntaxError(`Unrecognized AutoEq line: ${line}`);
      const rest = filter[3], fc = rest.match(new RegExp(`\\bFc\\s+(${number})\\s*Hz`, 'i'));
      const gain = rest.match(new RegExp(`\\bGain\\s+(${number})\\s*dB`, 'i'));
      const q = rest.match(new RegExp(`\\bQ\\s+(${number})(?:\\s|$)`, 'i'));
      const type = normalizeType(filter[2]);
      if (!fc || (['peaking', 'lowshelf', 'highshelf'].includes(type) && !gain)) throw new SyntaxError(`Missing filter parameters: ${line}`);
      bands.push(normalizeBand({ frequency: Number(fc[1]), gain: gain ? Number(gain[1]) : 0, q: q ? Number(q[1]) : Math.SQRT1_2,
        type, enabled: filter[1].toUpperCase() === 'ON' }));
    }
    if (!bands.length) throw new SyntaxError('No AutoEq parametric filters found.');
    return normalizePreset({ preamp, bands }, true);
  }

  function formatAutoEq(input) {
    const preset = normalizePreset(input, true);
    const names = { peaking: 'PK', lowshelf: 'LSC', highshelf: 'HSC', lowpass: 'LPQ', highpass: 'HPQ', notch: 'NO', bandpass: 'BP', allpass: 'AP' };
    const decimal = value => Number(value.toFixed(8)).toString();
    return [`Preamp: ${decimal(preset.preamp)} dB`, ...preset.bands.map((band, index) =>
      `Filter ${index + 1}: ${band.enabled ? 'ON' : 'OFF'} ${names[band.type]} Fc ${decimal(band.frequency)} Hz Gain ${decimal(band.gain)} dB Q ${decimal(band.q)}`)].join('\n');
  }

  return Object.freeze({ TYPES, DEVICE_TYPES, normalizeType, normalizeBand, normalizePreset, frequencyGrid,
    biquad, response, canonicalCurve, interpolateCurve, normalizeCurve, targetDifference, smoothCurve, fit,
    quantizePreset, parseOfficialJSON, formatOfficialJSON, parseAutoEq, formatAutoEq });
});
