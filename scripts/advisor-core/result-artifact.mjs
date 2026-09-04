const REQUIRED_SECTIONS = ["Status", "Claims", "Evidence", "Files", "Decisions", "Remaining Risk"];

function headings(lines) {
  const result = [];
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    result.push({ index, level: match[1]?.length ?? 1, title: match[2]?.trim() ?? "" });
  }
  return result;
}

function sectionLines(lines, allHeadings, heading) {
  const end = allHeadings.find(
    (candidate) => candidate.index > heading.index && candidate.level <= heading.level,
  )?.index ?? lines.length;
  return lines.slice(heading.index + 1, end);
}

function stripStatusMarkup(value) {
  return value.replace(/^[*_`]+/, "").replace(/[*_`]+$/, "").trim();
}

export function resultStatusLine(markdown) {
  const lines = markdown.split(/\r?\n/);
  let underStatusHeading = false;
  for (const line of lines) {
    if (!underStatusHeading) {
      underStatusHeading = /^\s*#{1,6}\s+status\s*#*\s*$/i.test(line);
      continue;
    }
    if (/^\s*#{1,6}\s+/.test(line)) return undefined;
    const status = line.trim();
    if (!status) continue;
    return stripStatusMarkup(status) || undefined;
  }
  return undefined;
}

function prose(lines) {
  return lines.map((line) => line.trim()).filter((line) => line && !/^#{1,6}\s+/.test(line));
}

export function validateResultArtifact(markdown) {
  if (!markdown.trim()) return { valid: false, problems: ["result artifact is empty"] };

  const lines = markdown.split(/\r?\n/);
  const allHeadings = headings(lines);
  const problems = [];
  const sections = new Map();
  for (const name of REQUIRED_SECTIONS) {
    const heading = allHeadings.find((candidate) => candidate.title.toLowerCase() === name.toLowerCase());
    if (!heading) {
      problems.push(`missing ${name} section`);
      continue;
    }
    const body = sectionLines(lines, allHeadings, heading);
    sections.set(name, { heading, lines: body });
    if (prose(body).length === 0) problems.push(`${name} section is empty`);
  }

  const status = resultStatusLine(markdown);
  if (sections.has("Status") && !status && !problems.includes("Status section is empty")) {
    problems.push("Status section has no first-line status");
  }
  const statusSection = sections.get("Status");
  let statusBody;
  if (statusSection && status) {
    const statusLineIndex = statusSection.lines.findIndex((line) => stripStatusMarkup(line.trim()) === status);
    const body = prose(statusSection.lines.slice(statusLineIndex + 1)).join("\n").trim();
    const inlineBlockedBody = /^blocked\b/i.test(status)
      ? status.replace(/^blocked\b\s*[:\-—]?\s*/i, "").trim()
      : "";
    statusBody = body || inlineBlockedBody || undefined;
  }

  return {
    valid: problems.length === 0,
    problems,
    ...(status ? { status } : {}),
    ...(statusBody ? { statusBody } : {}),
  };
}
