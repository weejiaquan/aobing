Original vector scenery drawn for Aobing:

- `sky-halos.svg`: concentric aerial rings and a vertical light column.
- `sky-clouds.svg`: layered cloud banks and wisps.
- `sky-city.svg`: a distant city, central tower, river, and foreground buildings.
- `sky-city-lights.svg`: window lights, reflections, and a tower beacon.

Visual inspiration supplied by the project owner: [day sky](https://cdn.ibispaint.com/movie/273/84/273084468/image273084468.png), [night sky](https://pbs.twimg.com/media/FzUGXFaaIAE34th.jpg).

Time-of-day gradients, warmth, and animated stars are separate CSS/DOM layers. The sky follows device-local wall-clock hours, with art-directed sunrise from 05:00–08:00 and sunset from 17:00–20:00; these are not location-based astronomical times. Time-preview selections are session-only; refreshing returns to device time unless an `hour` query parameter is present.
