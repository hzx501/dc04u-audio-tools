# Data provenance

## Included data

`curves.json` and `curves.js` contain the same three **synthetic demo curves** generated from mathematical functions. They do not represent any commercial headphone, measured sound pressure or established preference target. Frequencies span 20 Hz to 20 kHz and include 1 kHz.

`huihifi-catalog.json` and its browser script contain an empty catalog. `tests/fixtures/huihifi-raw-sample.json` is also synthetic; it exercises the external response schema without copying real measurements.

The UI calculates counts from the loaded data rather than claiming that the demo contains a complete headphone library.

## Original integration and references

The original local edition integrated data exposed by [MOONDROP HUB](https://hub.moondroplab.tech/), including a 48-curve snapshot and a HuiHiFi catalog of 1,111 records. Those counts describe the local research snapshot, not the contents of this repository.

Reference endpoints used by the integration:

- Official response catalog: `https://cdn-service.moondroplab.tech/api/v1/refresponse/all?type=OFFICIAL&pageIndex=1&pageSize=999`
- Reference/target catalog: `https://cdn-service.moondroplab.tech/api/v1/responselib/all`
- HuiHiFi brands: `https://cdn-service.moondroplab.tech/api/v1/huihifi/brands/all`
- A selected record: `https://cdn-service.moondroplab.tech/api/v1/huihifi/evaluations/{record-uuid}/raw-fr`

No redistribution licence for the original dataset was established during development, so copied measurement files and the full catalog are excluded from the public edition. Linking to a provider does not confer a licence to redistribute its data. Nothing here grants rights to third-party datasets.

## Bring your own data

For a small comparison, use the editor's import dialog with frequency/response CSV. Select the desired A/B side before importing.

For a complete local JSON library you are entitled to use:

```sh
node scripts/use-local-library.mjs /path/to/curves.json /path/to/huihifi-catalog.json
```

The catalog argument is optional. The script validates the input, generates the browser scripts locally and makes no network requests. It changes the local checkout's data files; review their permissions before committing them to any public repository.

Each curve has at least `id`, `name`, `kind` (`measurement` or `target`) and `points: [{frequency, db}]`. Optional provenance includes `rig`, `source`, `url` and measurement conditions. The loader keeps different groups and channels separate, preserves valid zero dB values and does not infer an unlabelled measurement rig from the headphone model.

## Filter equations

Filter response modelling uses the public [W3C Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/) biquad equations. The constrained fitting implementation is part of this project and is not represented as MOONDROP's private algorithm.
