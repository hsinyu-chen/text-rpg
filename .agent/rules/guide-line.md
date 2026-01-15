---
trigger: always_on
---

***
description: Project Coding Standards and Rules
***

# Code Quality Rules

- NO `@ts-ignore` (Strict Type Safety)
- NO `any` `unknown` (Use proper interfaces/types)

## Build Before Report
- use `npm run lint` `npm run build` to verify the code changes before report work done **DOT NOT RUN `npm run lint && npm run build`** , run it one by one

## Env
- Windows, Powershell
- use git grep for search