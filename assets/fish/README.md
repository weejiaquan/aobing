# Anime fishing sprites

Selected asset: `anime-atlas-v1.png` (1254 × 1254 RGBA PNG).

Created with the built-in `image_gen` tool on 2026-09-17. No external reference
images were used. The owner asked for bright anime mobile-game artwork after
finding the earlier painted set too realistic. The original selected sheet is
saved unchanged, with genuine alpha transparency. `painted-atlas-v2.png` is the
previous art direction, retained as an unused source asset.

The atlas contains 20 source illustrations across 19 families, including two
Tropical designs. `fish-sprite.js` uses measured rectangles and four contour
windows to keep neighboring long fins / tails out of each sprite. The original
PNG stays untouched. Species colorways and shiny finishes cover all 151 entries;
these are family-based variants, not 151 separately generated illustrations.
The texture cache is bounded to 64 small sprites; initial one-shot canvas draws
are queued until the atlas loads. Versioned script URLs prevent stale artwork.

Animation uses the unchanged source PNG: family-specific vertex weights deform
a small canvas mesh, while a shared 30fps controller pauses hidden, offscreen and
covered specimens. Heads stay steady; tails, fins, wings and tentacles flex.
Reduced motion renders the original rest pose. Catch and inspection sprites use
a short eased settle, and landing motion follows the scene's clock.

## Final generation prompt

> Use case: stylized-concept. Production game sprite sheet of 20 ORIGINAL aquatic creatures, transparent PNG with real alpha channel. Art direction: the bright, airy anime mobile-game item illustration aesthetic of Blue Archive: elegant thin navy linework, soft cel shading with two or three clear shadow masses plus gentle luminous gradients, crisp pastel cyan rim highlights, clean rich local colors, appealing expressive fish faces. Hand-drawn anime illustration, moderately stylized proportions, lively tapered shapes, graceful fins. Each fish has distinctive believable anatomy but no photorealistic scales, no painterly texture, no mottled skin detail, no gritty realism, no 3D rendering, no heavy black outlines. Do not use simple geometric oval bodies or generic triangle tails. Avoid mascot blobs and extreme baby chibi proportions. This is polished anime RPG collectible artwork, clear and charming at thumbnail size.
> Exact layout: four columns, five rows, exactly one complete creature per cell. HUGE empty transparent gutters. Keep each creature within the central 70% of its cell width AND height, including tails and all tentacles. No touching edges, no overlap, no clipping. Full side profiles facing RIGHT except top-view ray/crab and upright seahorse/jellyfish. No text, logos, UI, frames, grid lines, background, cast shadows, bubbles or drawn checkerboard. Empty pixels must have alpha zero.
> Exact row-major order and designs:
> Row1: rainbow trout with pale blue back and soft pink lateral stripe, fine selective speckles; confident olive-teal largemouth bass with a defined broad jaw and spined fin; sleek silvery cyan minnow; graceful orange-white koi with flowing ribbonlike fins.
> Row2: streamlined cobalt marlin with a long bill and elegant sail fin; pale slate-blue reef shark with swept fins and a subtly confident expression; yellow-and-sky-blue butterflyfish with graphic stripes; charming ice-blue ocean sunfish with correct tall truncated rear and long dorsal/anal fins.
> Row3: soft blue-gray catfish with long barbels and flattened head; a graceful jade moray eel curled in a loose S; warm cream-gold pufferfish with small neatly drawn spines and amber eye; indigo viperfish with an elongated body and angular toothy jaw, stylized mischievous rather than grotesque.
> Row4: navy-violet anglerfish with a cyan luminous lure and readable angular mouth; a cyan spotted eagle ray viewed from above, broad swept wings and intact whip tail; warm peach-gold seahorse with delicate segmented armor and curled tail; translucent lavender-and-cyan jellyfish with a luminous bell and flowing ribbon tentacles.
> Row5: coral-pink squid with a long tapered mantle and flowing separated arms; warm coral-orange shore crab with articulated legs and pincers; a rare silver-white and icy-cyan aquatic dragon fish with graceful long curled body, coral-like horns, translucent ribbon fins and subtle gold accents; royal blue and buttery-yellow angelfish with tall fins.
> Maintain a cohesive art-directed set. Prioritize soft anime cel rendering, strong specific silhouettes, lovely fin shapes and polished clean linework. Transparent background, square canvas.
