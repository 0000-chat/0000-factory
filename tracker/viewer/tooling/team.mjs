function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function linksIn(value) {
  return [...String(value ?? '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map(([, label, href]) => ({ label: label.trim(), href: href.trim() }));
}

function profileFields(body) {
  const fields = [];
  let current = null;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const field = /^- \*\*(.+?)\*\*:?\s*(.*)$/.exec(line);
    if (field) {
      current = { label: field[1].replace(/:\s*$/, '').trim(), value: field[2].trim() };
      fields.push(current);
    } else if (current && line.trim() && !/^##?\s/.test(line) && !/^- \*\*/.test(line)) {
      current.value = `${current.value} ${line.trim()}`.trim();
    }
  }
  return fields;
}

function observedDates(label) {
  const match = /\((\d{4}-\d{2}-\d{2})(?:\s+to\s+(\d{4}-\d{2}-\d{2}))?\)/i.exec(label);
  return match ? { start: match[1], end: match[2] ?? match[1] } : { start: null, end: null };
}

function latestObservations(fields) {
  const observations = fields
    .filter(field => /^observed work\b/i.test(field.label))
    .map(field => ({ ...field, dates: observedDates(field.label) }));
  const dated = observations.filter(field => field.dates.end);
  const latestDate = dated.map(field => field.dates.end).sort().at(-1) ?? null;
  const latest = latestDate ? dated.filter(field => field.dates.end === latestDate) : observations;
  const links = new Map();
  for (const field of latest) {
    for (const link of linksIn(field.value)) if (!links.has(link.href)) links.set(link.href, link);
  }
  const starts = latest.map(field => field.dates.start).filter(Boolean).sort();
  return {
    start: starts[0] ?? null,
    end: latestDate,
    text: latest.map(field => field.value.trim()).filter(Boolean).join('\n\n') || null,
    links: [...links.values()],
  };
}

function identity(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Parse experience and recent-work context without treating the guide as the roster. */
export function parseTeamGuide(markdown) {
  const sections = String(markdown ?? '').replaceAll('\r\n', '\n').split(/(?=^##\s+)/m);
  return sections.flatMap(section => {
    const heading = /^##\s+(.+?)\s*$/m.exec(section)?.[1]?.trim();
    if (!heading || /^maintenance$/i.test(heading)) return [];
    const linked = /^(.+?)\s+·\s+\[@([^\]]+)\]\(([^)]+)\)$/.exec(heading);
    const name = (linked?.[1] ?? heading).trim();
    const handle = linked?.[2] ?? null;
    const body = section.replace(/^##\s+.+?\n/, '');
    const fields = profileFields(body);
    const valueFor = (...labels) => fields.find(field => labels.includes(field.label.toLocaleLowerCase()))?.value ?? null;
    const fullName = valueFor('full name');
    const slackField = valueFor('slack');
    const slackLink = linksIn(slackField)[0] ?? null;
    const slackUrl = slackLink?.href ?? (/^https?:\/\//i.test(slackField ?? '') ? slackField : null);
    const aliases = String(valueFor('name aliases') ?? '').split(',').map(alias => alias.trim()).filter(Boolean);
    const observations = latestObservations(fields);
    const experience = valueFor('experience points');
    return [{
      id: handle ?? slugify(name),
      slug: slugify(handle ?? name),
      personId: valueFor('person id'),
      name,
      fullName,
      aliases: [...new Set([name, fullName, handle, ...aliases].filter(Boolean))],
      handle,
      githubUrl: linked?.[3] ?? null,
      slackUrl,
      slackTitle: valueFor('slack title'),
      organization: valueFor('organization'),
      strongAt: valueFor('strong at'),
      experience,
      experienceLinks: linksIn(experience),
      bestAssignments: valueFor('best assignments'),
      preference: valueFor('preference'),
      current: valueFor('current', 'current assignment'),
      observedWork: observations.text,
      observedWorkStart: observations.start,
      observedWorkAt: observations.end,
      observedWorkLinks: observations.links,
    }];
  });
}

export function validatePeopleRegistry(registry) {
  const issues = [];
  if (!registry || typeof registry !== 'object' || registry.schemaVersion !== 1) {
    return ['people registry must be an object with schemaVersion 1'];
  }
  const organizations = Array.isArray(registry.organizations) ? registry.organizations : [];
  const people = Array.isArray(registry.people) ? registry.people : [];
  if (!Array.isArray(registry.organizations)) issues.push('organizations must be an array');
  if (!Array.isArray(registry.people)) issues.push('people must be an array');

  const organizationIds = new Set();
  for (const organization of organizations) {
    const id = String(organization?.id ?? '').trim();
    if (!id) issues.push('organization id is required');
    else if (organizationIds.has(id)) issues.push(`duplicate organization id: ${id}`);
    organizationIds.add(id);
    if (!String(organization?.name ?? '').trim()) issues.push(`organization ${id || '(missing id)'} needs a name`);
  }

  const personIds = new Set();
  const slackIds = new Set();
  const githubHandles = new Set();
  for (const person of people) {
    const id = String(person?.id ?? '').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) issues.push(`invalid person id: ${id || '(missing)'}`);
    else if (personIds.has(id)) issues.push(`duplicate person id: ${id}`);
    personIds.add(id);
    if (!String(person?.name ?? '').trim()) issues.push(`person ${id || '(missing id)'} needs a name`);
    if (!['active', 'inactive'].includes(person?.status)) issues.push(`person ${id} needs status active or inactive`);
    if (!Array.isArray(person?.aliases)) issues.push(`person ${id} aliases must be an array`);
    const githubHandle = identity(person?.githubHandle);
    if (person?.githubHandle != null && !String(person.githubHandle).trim()) issues.push(`person ${id} githubHandle must be null or non-empty`);
    if (githubHandle) {
      if (githubHandles.has(githubHandle)) issues.push(`duplicate GitHub handle: ${person.githubHandle}`);
      githubHandles.add(githubHandle);
    }
    const slackId = String(person?.slackId ?? '').trim();
    if (slackId) {
      if (slackIds.has(slackId)) issues.push(`duplicate Slack id: ${slackId}`);
      slackIds.add(slackId);
    }
    const refs = Array.isArray(person?.organizationIds) ? person.organizationIds : [];
    if (!Array.isArray(person?.organizationIds)) issues.push(`person ${id} organizationIds must be an array`);
    for (const organizationId of refs) {
      if (!organizationIds.has(String(organizationId))) issues.push(`person ${id} references unknown organization: ${organizationId}`);
    }
    if (new Set(refs.map(String)).size !== refs.length) issues.push(`person ${id} has duplicate organization references`);
  }
  return issues;
}

/** Build the stable directory roster from people.json, enriching it with guide evidence. */
export function buildTeamProfiles(registry, guideMarkdown) {
  const issues = validatePeopleRegistry(registry);
  if (issues.length) throw new Error(`invalid people registry: ${issues.join('; ')}`);
  const organizationNames = new Map(registry.organizations.map(org => [String(org.id), String(org.name)]));
  const guideProfiles = parseTeamGuide(guideMarkdown);
  const registryIds = new Set(registry.people.map(person => String(person.id)));
  const guidePersonIds = new Set();
  for (const guideProfile of guideProfiles) {
    if (!guideProfile.personId) continue;
    if (!registryIds.has(String(guideProfile.personId))) issues.push(`team guide references unknown person id: ${guideProfile.personId}`);
    if (guidePersonIds.has(String(guideProfile.personId))) issues.push(`duplicate team guide person id: ${guideProfile.personId}`);
    guidePersonIds.add(String(guideProfile.personId));
  }
  if (issues.length) throw new Error(`invalid people registry or guide mapping: ${issues.join('; ')}`);

  const legacyGuideProfiles = guideProfiles.filter(profile => !profile.personId);
  const matchGuide = person => {
    const idMatch = guideProfiles.filter(profile => profile.personId && String(profile.personId) === String(person.id));
    if (idMatch.length === 1) return idMatch[0];
    const githubHandle = identity(person.githubHandle);
    const handleMatches = legacyGuideProfiles.filter(profile => githubHandle && profile.handle && identity(profile.handle) === githubHandle);
    if (handleMatches.length === 1) return handleMatches[0];
    if (handleMatches.length > 1) return null;
    const identifiers = new Set([person.id, person.name, person.fullName, person.githubHandle, ...(person.aliases ?? [])].map(identity).filter(Boolean));
    const aliasMatches = legacyGuideProfiles.filter(profile => [profile.name, profile.fullName, profile.handle, ...(profile.aliases ?? [])].some(value => identifiers.has(identity(value))));
    return aliasMatches.length === 1 ? aliasMatches[0] : null;
  };
  return registry.people.map(person => {
    const guide = matchGuide(person);
    const organizationIds = Array.isArray(person.organizationIds) ? person.organizationIds.map(String) : [];
    const githubHandle = person.githubHandle ? String(person.githubHandle) : null;
    const avatar = String(person.avatar ?? '').trim();
    return {
      ...(guide ?? {}),
      id: String(person.id),
      slug: String(person.id),
      name: String(person.name),
      fullName: person.fullName ? String(person.fullName) : null,
      aliases: [...new Set([person.name, person.fullName, githubHandle, ...(person.aliases ?? [])].filter(Boolean).map(String))],
      handle: githubHandle,
      githubHandle,
      githubUrl: githubHandle ? `https://github.com/${encodeURIComponent(githubHandle)}` : null,
      slackId: person.slackId ? String(person.slackId) : null,
      slackUrl: person.slackId ? `https://app.slack.com/team/${encodeURIComponent(String(person.slackId))}` : null,
      slackTitle: person.slackTitle ? String(person.slackTitle) : null,
      email: person.email ? String(person.email) : null,
      status: person.status ? String(person.status) : null,
      avatarUrl: avatar ? (avatar.startsWith('/') ? avatar : `/avatars/${avatar}`) : null,
      capacityPath: person.capacityPath ? String(person.capacityPath) : null,
      organizationIds,
      organizations: organizationIds.map(id => organizationNames.get(id)).filter(Boolean),
      strongAt: guide?.strongAt ?? null,
      experience: guide?.experience ?? null,
      experienceLinks: guide?.experienceLinks ?? [],
      bestAssignments: guide?.bestAssignments ?? null,
      preference: guide?.preference ?? null,
      current: guide?.current ?? null,
      observedWork: guide?.observedWork ?? null,
      observedWorkStart: guide?.observedWorkStart ?? null,
      observedWorkAt: guide?.observedWorkAt ?? null,
      observedWorkLinks: guide?.observedWorkLinks ?? [],
    };
  });
}
