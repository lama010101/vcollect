// =============================================================================
// Script parser — conventional (regex/line-based) music-video script parser.
// NO AI, NO LLM. Pure deterministic text parsing.
//
// Supported script format:
//
//   [0:00 INTRO]                    ← section header with start time
//   [0:15-0:48 VERSE_1]             ← section header with start-end time range
//   ♪ We light the world             ← lyrics line (collected per section)
//   ♪ Every step we take
//
//   1. Sunlight through trees — 2s   ← shot: number, description, duration
//      search: sunlight cinematic    ← explicit search query (optional)
//      ref: https://example.com/img.jpg  ← reference image URL (optional)
//      priority: 5                   ← priority override (optional)
//
// Rules:
//   - Section headers: [MM:SS SECTION] or [MM:SS-MM:SS SECTION]
//   - Lyrics: lines starting with ♪ (or "music:" / "lyric:")
//   - Shots: "N. description — Xs" (em-dash, en-dash, or hyphen accepted)
//   - Indented key:value lines after a shot modify that shot
//   - Empty lines and lines starting with # or // are ignored
//   - If no search: line, search_query is derived from the description
//   - If no section header precedes a shot, it goes into "UNGROUPED"
//
// Time computation:
//   - Each section has a start time (from header) defaulting to 0
//   - Shots within a section are packed sequentially using their durations
//   - time_start = section_start + sum of previous shot durations in section
//   - time_end = time_start + shot duration
// =============================================================================

export interface ParsedShot {
  shotNumber: number;
  section: string;
  lyrics: string | null;
  visualDescription: string;
  searchQuery: string;
  targetDurationSeconds: number;
  priority: number;
  referenceImageUrl: string | null;
  timeStartSeconds: number;
  timeEndSeconds: number;
}

export interface ParsedSection {
  name: string;
  startSeconds: number | null;
  endSeconds: number | null;
  lyrics: string[];
  shots: ParsedShot[];
}

export interface ParsedScript {
  sections: ParsedSection[];
  shots: ParsedShot[];
  totalDurationSeconds: number;
  errors: ParseError[];
}

export interface ParseError {
  line: number;
  text: string;
  message: string;
}

// --- Regex patterns ----------------------------------------------------------

// [0:15 INTRO]  or  [0:15-0:48 VERSE_1]  or  [1:23:45 SECTION]
const SECTION_RE = /^\[\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*)?([^\]]*)\]\s*$/;

// ♪ lyrics  or  music: lyrics  or  lyric: lyrics
const LYRICS_RE = /^(?:♪|music:|lyric:)\s*(.*)$/i;

// 1. description — 2s   or   1. description - 2.5s   or   1) description — 2s
const SHOT_RE = /^(\d+)[.)]\s*(.+?)\s*[—–\-]\s*(\d+(?:\.\d+)?)\s*s?\s*$/i;

// search: query  |  ref: url  |  priority: N
const SEARCH_RE = /^search:\s*(.+)$/i;
const REF_RE = /^ref:\s*(.+)$/i;
const PRIORITY_RE = /^priority:\s*(\d+)\s*$/i;

// Comment lines
const COMMENT_RE = /^(#|\/\/).*/;

// --- Time parsing ------------------------------------------------------------

/** Parse "M:SS" or "H:MM:SS" into seconds. Returns null if invalid. */
function parseTimecode(tc: string): number | null {
  const parts = tc.split(":");
  if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(s)) return m * 60 + s;
  } else if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (Number.isFinite(h) && Number.isFinite(m) && Number.isFinite(s)) {
      return h * 3600 + m * 60 + s;
    }
  }
  return null;
}

// --- Main parser -------------------------------------------------------------

export function parseScript(text: string): ParsedScript {
  const lines = text.split(/\r?\n/);
  const errors: ParseError[] = [];
  const sections: ParsedSection[] = [];

  let currentSection: ParsedSection | null = null;
  let currentShot: ParsedShot | null = null;
  let globalShotNumber = 0;
  let sectionTimeCursor = 0; // running time within the current section

  function ensureSection(): ParsedSection {
    if (!currentSection) {
      currentSection = {
        name: "UNGROUPED",
        startSeconds: null,
        endSeconds: null,
        lyrics: [],
        shots: [],
      };
      sections.push(currentSection);
    }
    return currentSection;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const lineNum = i + 1;

    // Skip empty lines and comments.
    if (line === "" || COMMENT_RE.test(line)) {
      continue;
    }

    // Section header: [0:15 INTRO] or [0:15-0:48 VERSE_1]
    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      const startTc = sectionMatch[1]!;
      const endTc = sectionMatch[2];
      const name = (sectionMatch[3] ?? "").trim() || "UNNAMED";
      const start = parseTimecode(startTc);
      if (start === null) {
        errors.push({ line: lineNum, text: raw, message: `Invalid timecode: "${startTc}"` });
        continue;
      }
      const end = endTc ? parseTimecode(endTc) : null;
      if (endTc && end === null) {
        errors.push({ line: lineNum, text: raw, message: `Invalid end timecode: "${endTc}"` });
        continue;
      }
      currentSection = {
        name: name.toUpperCase().replace(/\s+/g, "_"),
        startSeconds: start,
        endSeconds: end,
        lyrics: [],
        shots: [],
      };
      sections.push(currentSection);
      sectionTimeCursor = start;
      currentShot = null;
      continue;
    }

    // Lyrics line: ♪ lyrics
    const lyricsMatch = line.match(LYRICS_RE);
    if (lyricsMatch) {
      ensureSection().lyrics.push(lyricsMatch[1]!.trim());
      currentShot = null; // lyrics belong to the section, not a shot
      continue;
    }

    // Indented key:value modifiers for the current shot.
    if (currentShot && (raw.startsWith(" ") || raw.startsWith("\t"))) {
      const searchMatch = line.match(SEARCH_RE);
      if (searchMatch) {
        currentShot.searchQuery = searchMatch[1]!.trim();
        continue;
      }
      const refMatch = line.match(REF_RE);
      if (refMatch) {
        currentShot.referenceImageUrl = refMatch[1]!.trim();
        continue;
      }
      const priorityMatch = line.match(PRIORITY_RE);
      if (priorityMatch) {
        currentShot.priority = Math.min(10, Math.max(1, Number(priorityMatch[1])));
        continue;
      }
    }

    // Shot line: 1. description — 2s
    const shotMatch = line.match(SHOT_RE);
    if (shotMatch) {
      globalShotNumber++;
      const desc = shotMatch[2]!.trim();
      const duration = Number(shotMatch[3]);
      const sec = ensureSection();
      const timeStart = sec.startSeconds != null ? sectionTimeCursor : sectionTimeCursor;
      const timeEnd = timeStart + duration;
      sectionTimeCursor = timeEnd;

      currentShot = {
        shotNumber: globalShotNumber,
        section: sec.name,
        lyrics: sec.lyrics.length > 0 ? sec.lyrics.join("\n") : null,
        visualDescription: desc,
        searchQuery: desc, // default: derive from description; can be overridden
        targetDurationSeconds: duration,
        priority: 5,
        referenceImageUrl: null,
        timeStartSeconds: timeStart,
        timeEndSeconds: timeEnd,
      };
      sec.shots.push(currentShot);
      continue;
    }

    // If we get here, the line didn't match anything.
    // Don't error on short lines that might be continuation text.
    if (line.length > 0 && !line.match(/^[—–\-]+$/)) {
      errors.push({
        line: lineNum,
        text: raw,
        message: `Unrecognized line format. Expected [MM:SS SECTION], ♪ lyrics, or "N. description — Xs"`,
      });
    }
  }

  // Flatten all shots in order.
  const allShots = sections.flatMap((s) => s.shots);

  // Total duration = max time_end across all shots, or 0.
  const totalDuration = allShots.reduce(
    (max, s) => Math.max(max, s.timeEndSeconds),
    0,
  );

  return { sections, shots: allShots, totalDurationSeconds: totalDuration, errors };
}

// --- Sample script (for the UI "load sample" button) -------------------------

export const SAMPLE_SCRIPT = `[0:00 INTRO]
♪ instrumental

1. Sunlight filtering through trees — 2s
   search: sunlight through trees cinematic

2. Wide sunny landscape — 2s
   search: sunny landscape people outdoors

3. Child looking toward sunlight — 2s
   search: child looking sunlight outdoors

[0:15 VERSE_1]
♪ We light the world with every smile
♪ Every step we take is worthwhile

4. Children playing football — 3s
   search: children playing football outdoors

5. Children on playground — 3s
   search: children playground laughing
   ref: https://images.pexels.com/photos/1234/preview.jpg

6. Two children running together — 3s
   search: kids friendship running

[0:48 CHORUS_1]
♪ We are the light, we are the world

7. Children playing wide shot — 3s
   search: children playing wide shot

8. Happy children outdoors — 2s
   search: happy children outdoors

9. Family laughing together — 3s
   search: family laughing outdoors
`;
