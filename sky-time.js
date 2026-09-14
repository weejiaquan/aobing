/* Local wall-clock art direction, independent of location and network services. */
(function (root) {
  const stops = [
    [0, 0, 0], [5, 0, 0], [6, .35, .72], [7, .9, .2], [8, 1, 0],
    [16, 1, 0], [17, .95, .2], [18, .55, .7], [19, .15, .45], [20, 0, 0], [24, 0, 0],
  ];
  function getSkyState(hour) {
    if (!Number.isFinite(hour)) throw new TypeError('Sky time must be a finite hour');
    hour = ((hour % 24) + 24) % 24;
    const index = stops.findIndex((stop) => stop[0] > hour);
    const a = stops[index - 1], b = stops[index];
    const fraction = (hour - a[0]) / (b[0] - a[0]);
    const t = fraction * fraction * (3 - 2 * fraction);
    const daylight = a[1] + (b[1] - a[1]) * t;
    const warmth = a[2] + (b[2] - a[2]) * t;
    return {
      daylight, warmth, stars: Math.pow(1 - daylight, 2),
      phase: hour >= 5 && hour < 8 ? 'Sunrise' : hour >= 8 && hour < 17 ? 'Day' : hour >= 17 && hour < 20 ? 'Sunset' : 'Night',
      warmColor: hour < 12 ? '#efadc1' : '#f48c52',
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { getSkyState };
  else root.AobingSky = { getSkyState };
})(typeof window !== 'undefined' ? window : globalThis);
