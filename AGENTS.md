# Repository Guidelines

## Project Structure & Module Organization
This project uses the Next.js App Router. Place routed pages under `app/`, using `layout.tsx` for shared chrome and `page.tsx` for the home view. Shared styles live in `app/globals.css`. Static assets belong in `public/` and are automatically served from `/`. Configuration lives at the repo root (`next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `biome.json`). Keep feature-specific modules together inside `app/feature` directories to preserve co-location of components, hooks, and styles.

## Build, Test, and Development Commands
Run `yarn dev` to start the Turbopack dev server with hot reload. `yarn build` produces an optimized production bundle, and `yarn start` runs that bundle locally. Use `yarn lint` to run Biome checks (lint + type-aware rules), and `yarn format` to apply the canonical formatting before submitting changes.

## Coding Style & Naming Conventions
TypeScript and React 19 are required for all source files. Follow Biome’s 2-space indentation, trailing newline, and import ordering; the formatter enforces these choices. Name React components and hooks in PascalCase, utility modules in camelCase, and files that export a component using the component name (`HeroSection.tsx`). Co-locate CSS Modules or Tailwind styles with their component when relevant.

## Testing Guidelines
Automated tests are not yet configured, so add component tests (e.g., Playwright or Testing Library) under `app/__tests__/` as features grow. Keep test file names aligned with the source (`button.test.tsx`). Until a framework is added, validate changes with `yarn lint` and manual browser checks. Target meaningful coverage on new UI states and document exploratory testing in the PR.

## Commit & Pull Request Guidelines
The repository has no recorded history yet; use Conventional Commits (`feat:`, `fix:`, etc.) to keep future logs scannable. Keep subject lines under 72 characters and describe scope in the body if needed. Pull requests should link to their issue, summarize functional impact, list testing performed (commands, browsers), and include screenshots or screen recordings for UI-facing work.
