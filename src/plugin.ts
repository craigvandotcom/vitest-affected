/// <reference types="vitest/config" />
import type { Plugin } from 'vite';

export interface VitestAffectedOptions {
  disabled?: boolean;
  ref?: string;
  changedFiles?: string[];
  verbose?: boolean;
  threshold?: number;
  allowNoTests?: boolean;
}

export function vitestAffected(options: VitestAffectedOptions = {}): Plugin {
  return {
    name: 'vitest:affected',
    async configureVitest({ vitest, project }) {
      // TODO: implement in bd-310.5
    }
  };
}
