/**
 * Ours (governedwork fork), not upstream GBrain. Drop when upstream serves the
 * host skills directory beside an active shared catalog.
 *
 * Upstream: once shared publication is active, the unversioned `list_skills` /
 * `get_skill` read ONLY the sealed shared catalog, and the host skills directory
 * (`mcp.skills_dir`, normally GBrain's bundled skills) disappears. Upstream's way
 * back is to register that directory as its own source and adopt it through the
 * v0.53 migration (skills/migrations/v0.53.0.0.md §4). That needs a
 * filesystem-owned source per brain, which a database-only brain in a container
 * with no lasting disk cannot hold, and it would copy the bundled skills into
 * every brain's database and freeze them there across upgrades.
 *
 * So the unversioned catalog serves both: the shared skills, then every host
 * skill whose name no shared skill uses. On a name clash the shared skill wins
 * (it is the owner's published, sealed revision) and the host skill is named in
 * `shadowed_host_skills`, so the clash is reported instead of silent. The
 * source-qualified catalog (schema_version 2) is unchanged: host skills have no
 * source, incarnation or revision to qualify them by.
 */
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { getLegacySharedSkill, listLegacySharedSkills } from './compatibility.ts';
import type { GetSkillResult, ListSkillsResult } from '../skill-catalog.ts';
import type { ResidentSkillDetail } from '../skillpack/brain-resident-locate.ts';

export interface ListSkillsBesideHostResult extends ListSkillsResult {
  /** Host skills not listed because a shared skill has the same name. */
  shadowed_host_skills: string[];
}

/** The host skills directory, or null when this host has none (no override and nothing autodetected). */
async function hostSkillsDir(ctx: OperationContext) {
  const sc = await import('../skill-catalog.ts');
  sc.assertPublishEnabled(ctx, await sc.readMcpPublishSkills(ctx));
  const override = await sc.readMcpSkillsDir(ctx);
  try {
    return { sc, ...sc.resolveSkillsDir(ctx, override) };
  } catch (error) {
    // A configured directory that is missing stays an error, as it is without shared skills.
    if (!override && error instanceof OperationError && error.code === 'storage_error') return null;
    throw error;
  }
}

export async function listSkillsBesideHost(ctx: OperationContext, section?: string): Promise<ListSkillsBesideHostResult> {
  const shared = await listLegacySharedSkills(ctx, section);
  const host = await hostSkillsDir(ctx);
  if (!host) return { ...shared, shadowed_host_skills: [] };
  const hostCatalog = host.sc.buildSkillCatalog(ctx, host.dir, host.source, { section, gateDisabled: await host.sc.readSkillToolGates(ctx) });
  const sharedNames = new Set(shared.skills.map(skill => skill.name));
  const shadowed = hostCatalog.skills.filter(skill => sharedNames.has(skill.name)).map(skill => skill.name);
  const skills = [...shared.skills, ...hostCatalog.skills.filter(skill => !sharedNames.has(skill.name))]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ...shared, skills_dir_source: host.source, count: skills.length, skills, shadowed_host_skills: shadowed };
}

export async function getSkillBesideHost(ctx: OperationContext, name: unknown): Promise<GetSkillResult | ResidentSkillDetail> {
  if (typeof name === 'string' && name) {
    const shared = await listLegacySharedSkills(ctx);
    if (!shared.skills.some(skill => skill.name === name)) {
      const host = await hostSkillsDir(ctx);
      if (host) return host.sc.getSkillDetail(ctx, host.dir, name, { gateDisabled: await host.sc.readSkillToolGates(ctx) });
    }
  }
  return getLegacySharedSkill(ctx, name);
}
