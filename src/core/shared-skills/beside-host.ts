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
 * `shadowed_host_skills`, so the clash is reported instead of silent. Clashes are
 * decided against the whole shared catalog; `section` only filters what is
 * listed. The source-qualified catalog (schema_version 2) is unchanged: host
 * skills have no source, incarnation or revision to qualify them by.
 *
 * HOSTED BRAINS MUST SET `mcp.skills_dir`. For remote callers the host
 * directory is `mcp.skills_dir` or `autoDetectSkillsDir()`, which deliberately
 * has no install-path tier (skill-catalog.ts trust memo #5: a hosted gbrain
 * never serves its own bundled skills by accident). So on a hosted brain with
 * no `mcp.skills_dir`, and no `$GBRAIN_SKILLS_DIR`, OpenClaw workspace or
 * `skills/` above the server's working directory, remote callers get the shared
 * catalog only. `list_skills` says so in `host_skills.absent` instead of looking
 * like "the host has skills and none clash".
 *
 * Authorization: `get_skill` reads the shared catalog under the get_skill grant
 * only (never list_skills), as upstream does, and a name in neither catalog
 * returns the shared catalog's skill_not_found. Publishing off refuses a remote
 * caller in the shared read before any host skill is touched, as upstream does.
 */
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { getLegacySharedSkill, listLegacySharedSkills } from './compatibility.ts';
import type { GetSkillResult, ListSkillsResult, ResolvedSkillsDirSource } from '../skill-catalog.ts';
import type { ResidentSkillDetail } from '../skillpack/brain-resident-locate.ts';

/** Whether this call was served host skills, and from where; or why none. */
export type HostSkillsState = { served_from: ResolvedSkillsDirSource } | { absent: string };

export interface ListSkillsBesideHostResult extends ListSkillsResult {
  host_skills: HostSkillsState;
  /** Host skills not listed because a shared skill has the same name (whatever `section` asked for). */
  shadowed_host_skills: string[];
}

type SkillCatalogModule = typeof import('../skill-catalog.ts');
type HostSkillsDir =
  | { kind: 'dir'; sc: SkillCatalogModule; dir: string; source: ResolvedSkillsDirSource }
  | { kind: 'absent'; reason: string };

const ABSENT_REMOTE = 'No host skills directory is configured for remote callers, so only the shared skills are served. '
  + 'A hosted gbrain never serves its own bundled skills unless the host sets mcp.skills_dir (gbrain config set mcp.skills_dir <path>).';
const ABSENT_LOCAL = 'No host skills directory was found on this machine, so only the shared skills are served. '
  + 'Set one with gbrain config set mcp.skills_dir <path>.';

async function hostSkillsDir(ctx: OperationContext): Promise<HostSkillsDir> {
  const sc = await import('../skill-catalog.ts');
  sc.assertPublishEnabled(ctx, await sc.readMcpPublishSkills(ctx));
  const override = await sc.readMcpSkillsDir(ctx);
  try {
    return { kind: 'dir', sc, ...sc.resolveSkillsDir(ctx, override) };
  } catch (error) {
    // A configured directory that is missing stays an error, as it is without shared skills.
    if (!override && error instanceof OperationError && error.code === 'storage_error') {
      return { kind: 'absent', reason: ctx.remote === false ? ABSENT_LOCAL : ABSENT_REMOTE };
    }
    throw error;
  }
}

export async function listSkillsBesideHost(ctx: OperationContext, section?: string): Promise<ListSkillsBesideHostResult> {
  const shared = await listLegacySharedSkills(ctx);
  const wanted = section?.trim();
  const inSection = (skill: { section: string }) => !wanted || skill.section === wanted;
  const host = await hostSkillsDir(ctx);
  if (host.kind === 'absent') {
    const skills = shared.skills.filter(inSection);
    return { ...shared, count: skills.length, skills, host_skills: { absent: host.reason }, shadowed_host_skills: [] };
  }
  const hostCatalog = host.sc.buildSkillCatalog(ctx, host.dir, host.source, { gateDisabled: await host.sc.readSkillToolGates(ctx) });
  const sharedNames = new Set(shared.skills.map(skill => skill.name));
  const shadowed = hostCatalog.skills.filter(skill => sharedNames.has(skill.name)).map(skill => skill.name);
  const skills = [...shared.skills, ...hostCatalog.skills.filter(skill => !sharedNames.has(skill.name))]
    .filter(inSection)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ...shared, skills_dir_source: host.source, count: skills.length, skills,
    host_skills: { served_from: host.source }, shadowed_host_skills: shadowed };
}

export async function getSkillBesideHost(ctx: OperationContext, name: unknown): Promise<GetSkillResult | ResidentSkillDetail> {
  try {
    return await getLegacySharedSkill(ctx, name);
  } catch (sharedError) {
    // skill_not_found here means the get_skill grant's catalog has no skill of this name: the snapshot that
    // list_skills shadows by applies the same policy and audience filter (catalog.ts readSnapshot), and an
    // enabled policy always approves prose, so a listed skill's SKILL.md is never withheld from get_skill.
    if (!(sharedError instanceof OperationError) || sharedError.code !== 'skill_not_found' || typeof name !== 'string') throw sharedError;
    const host = await hostSkillsDir(ctx);
    if (host.kind === 'absent') throw sharedError;
    try {
      return host.sc.getSkillDetail(ctx, host.dir, name, { gateDisabled: await host.sc.readSkillToolGates(ctx) });
    } catch (hostError) {
      // In neither catalog: the shared catalog's refusal and its fix, not the host's.
      if (hostError instanceof OperationError && hostError.code === 'page_not_found') throw sharedError;
      throw hostError;
    }
  }
}
