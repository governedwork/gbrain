/** Meeting provider registry: one leaf per provider. */
import { firefliesProvider, type FirefliesOpts } from './fireflies.ts';
import { plaudProvider } from './plaud.ts';
import type { MeetingProvider, MeetingProviderName } from '../types.ts';
import { assertNever } from '../../types.ts';

/** Every provider gets the same options; a token-less provider (Plaud: an MCP login the SDK refreshes) ignores `token`. */
export type MeetingProviderOpts = FirefliesOpts;

export function meetingProvider(name: MeetingProviderName, opts: MeetingProviderOpts): MeetingProvider {
  switch (name) {
    case 'fireflies': return firefliesProvider(opts);
    case 'plaud': return plaudProvider({ userAgent: opts.userAgent, ...(opts.now ? { now: opts.now } : {}) });
    default: return assertNever(name);
  }
}
