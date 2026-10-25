# Verification record

Date: 2026-10-25 (Asia/Shanghai). Public edition based on local extension version 1.1.3.

## Automated checks

Run from the repository root:

```sh
node --test tests/*.test.cjs
```

The suite covers volume thresholds and reconnects, command parsing and buffer ownership, complete-gesture handling, the page integration, biquad response and device quantization, draft import/export, simulated device review/write/read-back behaviour, curve-loader validation and caching, and UI input/persistence/selection logic.

A/B regression cases include independently selecting a measured curve as B, parallel downloads resolving in reverse order, old responses arriving after a newer choice, failure recovery, imported target persistence, swapping while a download is pending, separate measurement groups and unknown rig metadata.

These are offline software tests using synthetic data, mock devices and simulated browser/controller objects. They do not send settings to a real DAC or play audio.

## Local original edition

The original 1.1.3 edition passed 145 offline tests. It was loaded in desktop Chrome on the official DC04U page; the extension popup reported active protection and a real device baseline. The new A/B search controls and version were observed on that page. Independent no-hardware browser preview checks confirmed that selecting a downloaded curve as B preserved A and the draft, including after reload.

The original curve data and device-session details are not copied into this repository. Screenshots in the public documentation use the synthetic-data preview where stated.

## Validation boundaries

- No real high-volume jump was intentionally sent for testing.
- No hardware EQ write or gain change was used as an acceptance test.
- The final acoustic response, exact firmware DSP sample rate and firmware filter implementation have not been measured.
- The vendor page's internal controller/store API can change.
- Software simulation and UI checks do not establish sound-pressure limits or hearing-safety guarantees.

## Public-edition checks

The synthetic-data public edition passed **145/145 offline tests**. The local JSON installer was also exercised in a disposable directory and generated the expected three-curve library and empty catalog. A browser preview confirmed synthetic labels, independent A/B names, dynamic counts (3 local curves / 0 catalog records) and a finite response plot. The installed local extension is a separate directory and is not replaced by publication work.
