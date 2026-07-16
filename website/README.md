# MeshHop website

Marketing site for MeshHop, a Windows desktop app that discovers, measures, and verifies public proxy exits before opening a dedicated routed browser.

## Local development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Validation

```bash
npm run lint
npx tsc --noEmit
npm run build
```

The downloadable Windows installer is served by the stable GitHub Release asset URL, so the website follows the latest published installer without storing a binary in the site repository. Example IPs and measurements in the product preview are explicitly labeled as illustrative data.

## Stack

- Next.js App Router
- React and TypeScript
- Tailwind CSS 4
- React Bits `BlurText` and `AnimatedContent`, adapted for reduced motion and resilient first paint
- `next/font` with Onest and Azeret Mono
