const REQUIRED_SECTIONS = ["Status", "Claims", "Evidence", "Files", "Decisions", "Remaining Risk"] as const;
const FALLBACK_STATUS = /^(?:PASS|FAIL|DONE|BLOCKED|IN PROGRESS|IN-PROGRESS)\b/i;

type ResultClassification = "blocked" | "in-progress" | "terminal";

interface MarkdownHeading {
	level: number;
	text: string;
}

interface SectionLabel {
	name: typeof REQUIRED_SECTIONS[number];
	level: number;
	inline: string;
}

interface Marker {
	index: number;
	level: number;
	section?: typeof REQUIRED_SECTIONS[number];
	inline?: string;
}

interface StatusInfo {
	status: string;
	lineIndex: number;
	marker?: Marker;
	lines: string[];
	allMarkers: Marker[];
}

export interface ResultArtifactValidation {
	valid: boolean;
	status?: string;
	classification: ResultClassification;
	problems: string[];
	notes: string[];
}

function markdownHeading(line: string): MarkdownHeading | undefined {
	const match = /^\s*(#{1,6})\s*(.+?)\s*#*\s*$/.exec(line);
	return match ? { level: match[1].length, text: match[2].trim() } : undefined;
}

function stripInlineMarkup(value: string): string {
	return value.trim().replace(/^[*_\x60]+/, "").replace(/[*_\x60]+$/, "").trim();
}

function sectionLabel(line: string): SectionLabel | undefined {
	const heading = markdownHeading(line);
	const source = (heading?.text ?? line.trim()).replace(/^[*_\x60]+/, "");
	for (const name of REQUIRED_SECTIONS) {
		const escaped = name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
		const pattern = name === "Status"
			? "^" + escaped + "[*_\\x60]*(?:(?:\\s*:\\s*|\\s+)(.*))?$"
			: "^" + escaped + "[*_\\x60]*\\s*:?\\s*$";
		const match = new RegExp(pattern, "i").exec(source);
		if (!match) continue;
		return {
			name,
			level: heading?.level ?? 1,
			inline: name === "Status" ? stripInlineMarkup(match[1] ?? "") : "",
		};
	}
	return undefined;
}

function markers(lines: string[]): Marker[] {
	const result: Marker[] = [];
	for (const [index, line] of lines.entries()) {
		const heading = markdownHeading(line);
		const section = sectionLabel(line);
		if (!heading && !section) continue;
		result.push({
			index,
			level: heading?.level ?? section?.level ?? 1,
			...(section ? { section: section.name, inline: section.inline } : {}),
		});
	}
	return result;
}

function markerEnd(allMarkers: Marker[], marker: Marker, lineCount: number): number {
	return allMarkers.find(
		(candidate) => candidate.index > marker.index && candidate.level <= marker.level,
	)?.index ?? lineCount;
}

function prose(lines: string[]): string[] {
	return lines
		.map((line) => line.trim())
		.filter((line) => line && !markdownHeading(line));
}

function statusInfo(markdown: string): StatusInfo | undefined {
	const lines = markdown.split(/\r?\n/);
	const allMarkers = markers(lines);
	const marker = allMarkers.find((candidate) => candidate.section === "Status");
	if (marker) {
		if (marker.inline) return { status: marker.inline, lineIndex: marker.index, marker, lines, allMarkers };
		for (let index = marker.index + 1; index < lines.length; index += 1) {
			if (!lines[index].trim()) continue;
			if (markdownHeading(lines[index]) || sectionLabel(lines[index])) break;
			const status = stripInlineMarkup(lines[index]);
			return status ? { status, lineIndex: index, marker, lines, allMarkers } : undefined;
		}
		return undefined;
	}

	let seen = 0;
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		seen += 1;
		if (seen > 10) break;
		const candidate = stripInlineMarkup(line.trim().replace(/^-+\s*/, ""));
		if (FALLBACK_STATUS.test(candidate)) return { status: candidate, lineIndex: index, lines, allMarkers };
	}
	return undefined;
}

export function resultStatusLine(markdown: string): string | undefined {
	return statusInfo(markdown)?.status;
}

export function resultStatusBody(markdown: string): string | undefined {
	const info = statusInfo(markdown);
	if (!info || !/^blocked\b/i.test(info.status)) return undefined;
	let body = "";
	if (info.marker) {
		const end = markerEnd(info.allMarkers, info.marker, info.lines.length);
		body = prose(info.lines.slice(info.lineIndex + 1, end)).join("\n").trim();
	}
	const inline = info.status.replace(/^blocked\b\s*[:\-—]?\s*/i, "").trim();
	return body || inline || undefined;
}

function classification(status: string | undefined): ResultClassification {
	if (/^blocked\b/i.test(status ?? "")) return "blocked";
	if (/^in(?: progress|-progress)\b/i.test(status ?? "")) return "in-progress";
	return "terminal";
}

export function validateResultArtifact(markdown: string): ResultArtifactValidation {
	if (!markdown.trim()) {
		return {
			valid: false,
			classification: "terminal",
			problems: ["result artifact is empty"],
			notes: [],
		};
	}

	const lines = markdown.split(/\r?\n/);
	const allMarkers = markers(lines);
	const notes: string[] = [];
	for (const name of REQUIRED_SECTIONS) {
		const marker = allMarkers.find((candidate) => candidate.section === name);
		if (!marker) {
			notes.push("missing " + name);
			continue;
		}
		const end = markerEnd(allMarkers, marker, lines.length);
		const content = [marker.inline, ...prose(lines.slice(marker.index + 1, end))].filter(Boolean);
		if (content.length === 0) notes.push("empty " + name);
	}

	const status = resultStatusLine(markdown);
	if (!status) notes.push("no Status line found");
	return {
		valid: true,
		...(status ? { status } : {}),
		classification: classification(status),
		problems: [],
		notes,
	};
}
