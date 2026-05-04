import '@angular/compiler';
import 'zone.js';
import 'zone.js/testing';
import { afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

afterEach(() => {
  TestBed.resetTestingModule();
});
