/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: import('./types/index').User;
    locale: 'zh' | 'en';
  }
}

