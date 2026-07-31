# Demo reference photos

Reference photography for the National Foods demo products. Put the image files
in this folder, then run:

```bash
npm run seed:demo-photos
```

The photos themselves are **not committed** (see `.gitignore`) — they're local
demo assets. Only this README is tracked.

## Why this exists

The nfoods.com scraper can't populate the catalogue: its configured URLs no
longer match the live site, and the product images there are lazy-loaded by
JavaScript, so a `fetch()` + Cheerio scraper reads empty `src` attributes even
with the URLs corrected. This is the manual path around that.

Without a `reference_image_url`, a National Foods scan has nothing to compare
against — neither vector search nor the structural comparison can produce an
image-based signal, and the verdict falls through to "unverified".

## Required files

| Filename | Product | SKU |
|---|---|---|
| `national-ketchup.jpg` | National Ketchup 400g | `8901030100019` |
| `national-mayo.jpg` | National Mayonnaise 500ml | `8901030200013` |
| `national-tawa-chicken.jpg` | National Tawa Chicken Recipe Mix | `8901030300010` |

The filenames must match exactly — they're hardcoded in `REFERENCE_PHOTOS` in
`scripts/seed-demo-reference-photos.ts`. To add another product, add an entry
there. If its SKU already exists (i.e. `prisma/seed.ts` creates it), the photo is
just attached; give the entry a `productName` and the row is created for you.

## ⚠️ Anything you scan on stage must be listed here

Path A reports a National Foods product that is **not in the catalogue** as a
counterfeit — that is the entire premise of the RAG path: the catalogue is
assumed complete for this brand, so absence is evidence.

With only a few rows seeded, that assumption does not hold. **A genuine National
Foods product you have not seeded will be reported as a fake.** Before demoing,
make sure every product you intend to scan has an entry above and shows
`embedding ✅` after seeding.

## How to take the photos

The reference photo is what every scan gets compared against, so **shoot it the
way the product will be scanned**, not the way a catalogue shot looks.

- **Plain, uncluttered background** — a white or light table. Nothing else in
  frame; background clutter is measured as if it were part of the product.
- **Straight-on, front of pack.** No tilt, no angle, no perspective.
- **Fill the frame** with the pack, small even margin around it. If the scan is
  a close-up and the reference is a distant shot, they won't match.
- **Even, indirect light.** No flash, no hard shadow across the label, no glare
  on glossy packaging.
- **In focus**, especially the wordmark and any printed text.
- **Portrait orientation**, matching how someone holds a phone at a shelf.
- JPEG, a couple of megapixels is plenty.

Shoot all products in the same spot with the same lighting and framing. The
comparison is sensitive to how the photo was taken — consistency between the
reference and the scan matters more than absolute image quality.

## After running

The script prints a per-product summary. You want `upload ✅  db ✅  embedding ✅`
on every row.

`embedding ⚠️` means the reference image was saved but no vector was stored, so
**vector search will not match that product** — the demo will fall through to
"unverified" for it. Check the warning before going on stage.

To confirm end to end, scan the real product through the app and check the
result screen names the product and reports a similarity score.
