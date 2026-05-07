// @ts-check
const eslint = require("@eslint/js");
const { defineConfig } = require("eslint/config");
const tseslint = require("typescript-eslint");
const angular = require("angular-eslint");

module.exports = defineConfig([
  {
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    processor: angular.processInlineTemplates,
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@angular-eslint/directive-selector": [
        "error",
        {
          type: "attribute",
          prefix: "app",
          style: "camelCase",
        },
      ],
      "@angular-eslint/component-selector": [
        "error",
        {
          type: "element",
          prefix: "app",
          style: "kebab-case",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          "paths": [
            {
              "name": "@angular/core",
              "importNames": [
                "Input",
                "Output",
                "ViewChild",
                "ViewChildren",
                "ContentChild",
                "ContentChildren",
                "HostListener",
                "HostBinding"
              ],
              "message": "Use signal-based APIs (input, output, viewChild, etc.) instead of legacy decorators. for host , use host field in @Component"
            }
          ]
        }
      ],
      "no-restricted-globals": [
        "error",
        {
          "name": "document",
          "message": "Inject DOCUMENT from @angular/common instead of using the document global."
        },
        {
          "name": "navigator",
          "message": "Use Clipboard from @angular/cdk/clipboard, or inject WINDOW and read .navigator, instead of the navigator global."
        }
      ],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.object.property.name=/^(queryParams|params|paramMap|queryParamMap|url|fragment|data|events|valueChanges|statusChanges)$/][callee.property.name='subscribe']",
          "message": "Don't .subscribe() to router / form observables. Use input() with withComponentInputBinding, toSignal(), or signal-based equivalents. (Legit Subject pipelines inside services are allowed.)"
        },
        {
          "selector": "CallExpression[callee.object.callee.property.name=/^(get|post|put|patch|delete|head|options|request)$/][callee.property.name='subscribe']",
          "message": "Don't .subscribe() to HttpClient calls. Use httpResource(), resource(), or rxResource() instead."
        },
        {
          "selector": "MethodDefinition[key.name=/^ng(OnChanges|OnInit|DoCheck|AfterContentInit|AfterContentChecked|AfterViewInit|AfterViewChecked)$/]",
          "message": "Legacy lifecycle hooks are banned. Use effect(), resource(), rxResource(), httpResource(), or toSignal() triggers, or afterNextRender() instead."
        },
        {
          "selector": "ClassDeclaration:has(Decorator[expression.callee.name=/^(Component|Directive|Injectable)$/]) MethodDefinition[key.name='constructor'][value.params.length>0]",
          "message": "Constructor injection is banned. Use inject() instead."
        },
        {
          "selector": "MemberExpression[object.name='window'][property.name=/^(location|innerWidth|innerHeight|outerWidth|outerHeight|addEventListener|removeEventListener|setTimeout|clearTimeout|setInterval|clearInterval|URL)$/]",
          "message": "Use the injected WINDOW token (from app/core/tokens/window.token.ts) instead of bare window.* — or use the bare global (setTimeout, URL) directly."
        }
      ],
    },
  },
  {
    files: ["**/*.html"],
    extends: [
      angular.configs.templateRecommended,
      angular.configs.templateAccessibility,
    ],
    rules: {},
  }
]);
