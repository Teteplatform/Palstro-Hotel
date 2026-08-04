// THE STAFF GUIDE, LOADED FROM THE REPO FILE — one source, two surfaces.
//
// `docs/USER-GUIDE.md` is the guide. It is a repo document (readable on disk, in
// a pull request, on GitHub) AND the content of the in-app Help page, because
// this module imports that exact file as a string with Vite's `?raw` suffix and
// the Help page renders what comes back. There is no second copy of the prose in
// a component, and there is nothing to keep in step: editing the markdown changes
// both surfaces in one commit.
//
// WHY `?raw` RATHER THAN A CONTENT MODULE OR A FETCH:
//   * it is Vite's own primitive — no plugin, no dependency, no build step;
//   * the file is inlined at BUILD time, so the Help page needs no network call
//     and works exactly as fast as any other admin screen;
//   * a typo in the path is a build error, not a 404 discovered by a receptionist
//     at 02:00.
// (`?url` would ship it as a fetchable asset and `?raw` would still be needed to
// read it; a generated .ts content module would be a build step that can go
// stale. This is the smallest correct thing.)
//
// WHAT THIS MODULE ADDS on top of parsing is the SHAPE the Help page needs: the
// document as SECTIONS (the H2s — Front desk, Manager, Owner) each holding its
// TASKS (the H3s — "Checking a guest in"). That grain is the whole point of the
// page. A guide searched by section would answer "discount" with four
// thousand-word sections; searched by TASK it answers with "Giving a discount"
// and "Reversing a discount", which is somebody finding what they need in a tap.

import guideSource from '../../docs/USER-GUIDE.md?raw';
import { blockText, parseMarkdown, type Block } from './markdown';

export interface GuideTask {
  // The H3 anchor — what a contents entry and a shared link point at.
  id: string;
  title: string;
  // The H3 heading itself plus everything under it, so rendering a task renders
  // its own heading and nothing has to be reconstructed.
  blocks: Block[];
  // Lower-cased plain text of the task, precomputed: search runs over every task
  // on every keystroke, and re-walking the tree each time would be work done
  // thousands of times for a document that never changes.
  searchText: string;
}

export interface GuideSection {
  // The H2 anchor.
  id: string;
  title: string;
  // What sits between the H2 and its first H3 — the section's own opening.
  lead: Block[];
  tasks: GuideTask[];
  // The lead's text only. A task's text is on the task; keeping them apart is
  // what lets a search show the two tasks that matched instead of the section
  // that contains them.
  leadSearchText: string;
}

export interface Guide {
  title: string;
  // The blocks before the first H2 — the "what this is / how to use it" opening.
  intro: Block[];
  sections: GuideSection[];
}

// One search result: a section, and which of its parts matched.
export interface GuideMatch {
  section: GuideSection;
  // True when the section's own opening matched (always true with no query).
  showLead: boolean;
  // The tasks that matched — every task when there is no query.
  tasks: GuideTask[];
}

function buildGuide(source: string): Guide {
  const blocks = parseMarkdown(source);

  let title = 'Staff guide';
  const intro: Block[] = [];
  const sections: GuideSection[] = [];
  let section: GuideSection | null = null;
  let task: GuideTask | null = null;

  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === 1) {
      title = block.text;
      continue;
    }

    // Horizontal rules are the MARKDOWN document's separators between major
    // parts. On the Help page each section is already its own card, so a rule
    // renders as a stray line at the foot of one — dropped here rather than
    // special-cased in the renderer, which has no idea it is inside a card.
    if (block.kind === 'rule') continue;

    if (block.kind === 'heading' && block.level === 2) {
      section = {
        id: block.id,
        title: block.text,
        lead: [],
        tasks: [],
        leadSearchText: '',
      };
      task = null;
      sections.push(section);
      continue;
    }

    if (section === null) {
      intro.push(block);
      continue;
    }

    if (block.kind === 'heading' && block.level === 3) {
      task = {
        id: block.id,
        title: block.text,
        blocks: [block],
        searchText: '',
      };
      section.tasks.push(task);
      continue;
    }

    if (task === null) section.lead.push(block);
    else task.blocks.push(block);
  }

  for (const s of sections) {
    s.leadSearchText = `${s.title}\n${blockText(s.lead)}`.toLowerCase();
    for (const t of s.tasks) {
      // The section title is folded into each task's text so "manager reverse
      // payment" finds the task under Manager — people search with the words
      // they see on screen, and the section heading is one of them.
      t.searchText = `${s.title}\n${blockText(t.blocks)}`.toLowerCase();
    }
  }

  return { title, intro, sections };
}

// Parsed ONCE, at module load. The document is a constant — nothing about it
// varies per user, per property or per render.
export const USER_GUIDE: Guide = buildGuide(guideSource);

/**
 * Search the guide, task by task.
 *
 * Every word in the query must appear in the task (or in the section's opening),
 * so "reverse payment" narrows to the one task rather than widening to
 * everything containing either word. Matching is over the whole text — steps,
 * table cells, not only headings — because "manager PIN" should find a task
 * whose heading says "approval PIN".
 *
 * An empty query returns everything: the guide's normal state is all of it.
 */
export function searchGuide(
  query: string,
  guide: Guide = USER_GUIDE,
): GuideMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return guide.sections.map((section) => ({
      section,
      showLead: true,
      tasks: section.tasks,
    }));
  }

  const hits = (text: string) => terms.every((term) => text.includes(term));

  const matches: GuideMatch[] = [];
  for (const section of guide.sections) {
    const showLead = hits(section.leadSearchText);
    const tasks = section.tasks.filter((t) => hits(t.searchText));
    if (showLead || tasks.length > 0) matches.push({ section, showLead, tasks });
  }
  return matches;
}

// How many individual tasks a result set holds — what the "N tasks match" line
// counts. A section whose own opening matched but which has no tasks (the
// permission table, the glossary) still counts as one result, so the number is
// never smaller than the number of cards on screen.
export function countMatches(matches: GuideMatch[]): number {
  return matches.reduce(
    (sum, m) => sum + (m.tasks.length > 0 ? m.tasks.length : 1),
    0,
  );
}
