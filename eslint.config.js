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
    processor: angular.processInlineTemplates,
    rules: {
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
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name='subscribe']",
          "message": "Manual .subscribe() is banned. Use resource(), rxResource(), httpResource(), or toSignal() instead."
        },
        {
          "selector": "MethodDefinition[key.name=/^ng(OnChanges|OnInit|DoCheck|AfterContentInit|AfterContentChecked|AfterViewInit|AfterViewChecked)$/]",
          "message": "Legacy lifecycle hooks are banned. Use effect(), resource(), rxResource(), httpResource(), or toSignal() triggers, or afterNextRender() instead."
        },
        {
          "selector": "ClassDeclaration:has(Decorator[expression.callee.name=/^(Component|Directive|Injectable)$/]) MethodDefinition[key.name='constructor'][value.params.length>0]",
          "message": "Constructor injection is banned. Use inject() instead."
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
