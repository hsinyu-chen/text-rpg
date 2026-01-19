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

# ANGULAR 21+ CODING STANDARDS
**THIS IS ZONELESS PROJECT**

## 🚫 NEGATIVE CONSTRAINTS (HARD BANS)
1. **NO Manual Subscriptions**: BANNED `.subscribe()`. Use `resource` or `rxResource`.
2. **NO Manual Loading State**: BANNED manual flags like `isLoading = signal(false)`. Use `resource.isLoading()`.
3. **NO Constructor Injection**: BANNED `constructor(private http: HttpClient)`. Use `inject()`.
4. **NO Zone.js**: BANNED `ngOnChanges`, `ngOnInit` (mostly). Use `effect()` or `resource` triggers.
5. **NO Classic Decorators**: BANNED `@Input`, `@Output`, `@ViewChild`, `@HostListener`.
6. **NO Modules**: Standalone Components ONLY.
7. **NO Computed Side-Effects**: Do not use `computed()` for writable state. Use `linkedSignal`.

## ✅ REQUIRED PATTERNS (DO THIS)

### 1. Asynchronous Data (The Resource Pattern)
- **Fetch**: Use `resource` (experimental/stable in v21) or `httpResource` for API calls.
  - Pattern: `data = httpResource(() => '/api/data/' + this.id());`
- **State**: Access via `.value()`, `.isLoading()`, `.error()`.
- **Mutations**: Use `resource.reload()` or `.update()`.

### 2. Dependent Writable State (Linked Signal)
- Use `linkedSignal` when state depends on another signal but must remain writable (e.g., resetting form on ID change).
  - Pattern: `quantity = linkedSignal({ source: this.product, computation: () => 1 });`

### 3. Signal IO & Queries
- `input.required<T>()` / `output<T>()` / `model<T>()`
- `viewChild.required<T>()`

### 4. Modern Architecture
- **DI**: `private _data = inject(DataService);`
- **Change Detection**: `ChangeDetectionStrategy.OnPush` (Always).
- **Files**: Split `.ts`, `.html`, `.scss`.

## 📝 CODE EXAMPLE (ANGULAR v21)

```typescript
import { Component, inject, input, linkedSignal, effect, ChangeDetectionStrategy } from '@angular/core';
import { httpResource } from '@angular/common/http'; // v21 Standard

@Component({
  selector: 'app-future-widget',
  standalone: true,
  imports: [],
  templateUrl: './future-widget.component.html',
  styleUrl: './future-widget.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class FutureWidgetComponent {
  // 1. Signal Input
  userId = input.required<string>();

  // 2. Resource API (Auto-manages loading/error/refetch)
  // Replaces HttpClient.get() + subscribe() + switchMap
  userResource = httpResource(() => `/api/v1/users/${this.userId()}`);

  // 3. Linked Signal (Resets to 'editing' mode when user changes)
  // Replaces complex effects or ngOnChanges
  mode = linkedSignal({
    source: this.userId,
    computation: () => 'view' as 'view' | 'edit'
  });

  constructor() {
    effect(() => {
      // 4. Reactive Logging
      console.log(`User ${this.userId()} loaded:`, this.userResource.value());
    });
  }

  refresh() {
    // Native refresh capability
    this.userResource.reload();
  }
}

**THIS IS ZONELESS PROJECT**