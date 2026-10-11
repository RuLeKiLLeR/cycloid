import type React from "react";
import { useCallback, useMemo, useRef, useState } from "react";

import { isValidSkillName, type SkillMetadata } from "../../../../../shared/skills/index";
import { useSyncEffect } from "../../hooks/useEffects";
import { parseAtTokens } from "../../utils/prompt-form";
import type { PromptFormProps } from "./types";

function fuzzyScore(query: string, filePath: string): number {
  const lowerQuery = query.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  if (!lowerPath.includes(lowerQuery)) return -1;
  let score = 100 - lowerPath.indexOf(lowerQuery);
  const base = lowerPath.split("/").pop() ?? "";
  if (base.startsWith(lowerQuery)) score += 50;
  if (base === lowerQuery) score += 25;
  return score;
}

function detectAtToken(text: string, caretPos: number): { query: string; start: number } | null {
  let index = caretPos - 1;
  while (index >= 0 && text[index] !== "@" && !/\s/.test(text[index])) index--;
  if (index < 0 || text[index] !== "@") return null;
  if (index > 0 && !/\s/.test(text[index - 1])) return null;
  const query = text.slice(index + 1, caretPos);
  return { query, start: index };
}

function detectLeadingSlashCommand(
  text: string,
  caretPos: number,
  canLoadSkills: boolean,
): { query: string; start: number } | null {
  if (!canLoadSkills || !text.startsWith("/")) return null;
  const beforeCaret = text.slice(0, caretPos);
  if (/\n/.test(beforeCaret)) return null;

  const tokenStart = Math.max(beforeCaret.lastIndexOf(" "), beforeCaret.lastIndexOf("\t")) + 1;
  if (text[tokenStart] !== "/") return null;
  const query = text.slice(tokenStart + 1, caretPos);
  if (/\s/.test(query)) return null;

  const previous = text.slice(0, tokenStart).trim();
  if (previous) {
    const tokens = previous.split(/\s+/);
    if (tokens.some((token) => !token.startsWith("/") || !isValidSkillName(token.slice(1)))) return null;
  }

  return { query, start: tokenStart };
}

function getFileAutocompleteResults(
  filesCache: string[] | null,
  atTokenStart: number | null,
  value: string,
  caret: number,
) {
  if (!filesCache || atTokenStart === null) return [];
  const query = value.slice(atTokenStart + 1, caret);
  if (!query && filesCache.length > 200) return filesCache.slice(0, 8);
  const scored: Array<{ path: string; score: number }> = [];
  for (const filePath of filesCache) {
    const score = query ? fuzzyScore(query, filePath) : 0;
    if (!query || score > -1) scored.push({ path: filePath, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((result) => result.path);
}

function getSkillAutocompleteResults(
  skillsCache: SkillMetadata[] | null,
  slashTokenStart: number | null,
  value: string,
  caret: number,
) {
  if (!skillsCache || slashTokenStart === null) return [];
  const query = value.slice(slashTokenStart + 1, caret).toLowerCase();
  return skillsCache.filter((skill) => !query || skill.name.toLowerCase().includes(query)).slice(0, 8);
}

function removeAttachedFileToken(value: string, path: string) {
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(^|\\s)@${escapedPath}(?=\\s|$)`, "g");
  return value
    .replace(regex, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildHighlightedPromptHtml(value: string, fileSet: Set<string> | null) {
  if (!fileSet || !value) return "";
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    escaped.replace(/(^|\s)@(\S+)/g, (_match, whitespace, path) => {
      const escapedPath = path as string;
      const rawPath = escapedPath.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (fileSet.has(rawPath)) {
        return `${whitespace}<span class="text-accent">@${escapedPath}</span>`;
      }
      return `${whitespace}@${escapedPath}`;
    }) + "\n"
  );
}

export function usePromptAutocomplete({
  value,
  setValue,
  reasoningEffort,
  loadFiles,
  loadSkills,
  textareaRef,
  highlightRef,
  onNonEmptyInput,
}: {
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  reasoningEffort: string | undefined;
  loadFiles?: PromptFormProps["loadFiles"];
  loadSkills?: PromptFormProps["loadSkills"];
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  highlightRef: React.RefObject<HTMLDivElement>;
  onNonEmptyInput: () => void;
}) {
  const [filesCache, setFilesCache] = useState<string[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [skillsCache, setSkillsCache] = useState<SkillMetadata[] | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [showSkillAutocomplete, setShowSkillAutocomplete] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [skillAutocompleteIndex, setSkillAutocompleteIndex] = useState(0);
  const [atTokenStart, setAtTokenStart] = useState<number | null>(null);
  const [slashTokenStart, setSlashTokenStart] = useState<number | null>(null);
  const loadFilesRef = useRef(loadFiles);
  const loadSkillsRef = useRef(loadSkills);
  loadFilesRef.current = loadFiles;
  loadSkillsRef.current = loadSkills;

  useSyncEffect(() => {
    setFilesCache(null);
  }, [loadFiles]);

  useSyncEffect(() => {
    setSkillsCache(null);
    setShowSkillAutocomplete(false);
    setSlashTokenStart(null);
  }, [loadSkills]);

  const triggerFileLoad = useCallback(() => {
    if (filesCache !== null || filesLoading || !loadFilesRef.current) return;
    setFilesLoading(true);
    loadFilesRef
      .current(reasoningEffort)
      .then((files) => {
        setFilesCache(files);
      })
      .catch((err) => {
        console.error("[PromptForm] Failed to load files", err);
      })
      .finally(() => {
        setFilesLoading(false);
      });
  }, [filesCache, filesLoading, reasoningEffort]);

  const triggerSkillLoad = useCallback(() => {
    if (skillsCache !== null || skillsLoading || !loadSkillsRef.current) return;
    setSkillsLoading(true);
    loadSkillsRef
      .current()
      .then((skills) => {
        setSkillsCache(skills);
      })
      .catch((err) => {
        console.error("[PromptForm] Failed to load skills", err);
      })
      .finally(() => {
        setSkillsLoading(false);
      });
  }, [skillsCache, skillsLoading]);

  const updateAutocomplete = useCallback(
    (text: string, caretPos: number) => {
      const slash = detectLeadingSlashCommand(text, caretPos, !!loadSkillsRef.current);
      if (slash) {
        setSlashTokenStart(slash.start);
        setShowSkillAutocomplete(true);
        setSkillAutocompleteIndex(0);
        setShowAutocomplete(false);
        setAtTokenStart(null);
        triggerSkillLoad();
        return;
      }

      setShowSkillAutocomplete(false);
      setSlashTokenStart(null);

      const at = detectAtToken(text, caretPos);
      if (at) {
        setAtTokenStart(at.start);
        setShowAutocomplete(true);
        setAutocompleteIndex(0);
        triggerFileLoad();
      } else {
        setShowAutocomplete(false);
        setAtTokenStart(null);
      }
    },
    [triggerFileLoad, triggerSkillLoad],
  );

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      setValue(next);
      if (next.trim()) onNonEmptyInput();
      updateAutocomplete(next, event.target.selectionStart ?? next.length);
    },
    [onNonEmptyInput, setValue, updateAutocomplete],
  );

  const handleSelect = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const element = event.currentTarget;
      updateAutocomplete(element.value, element.selectionStart ?? element.value.length);
    },
    [updateAutocomplete],
  );

  const autocompleteResults = useMemo(
    () =>
      getFileAutocompleteResults(filesCache, atTokenStart, value, textareaRef.current?.selectionStart ?? value.length),
    [atTokenStart, filesCache, textareaRef, value],
  );

  const skillAutocompleteResults = useMemo(
    () =>
      getSkillAutocompleteResults(
        skillsCache,
        slashTokenStart,
        value,
        textareaRef.current?.selectionStart ?? value.length,
      ),
    [skillsCache, slashTokenStart, textareaRef, value],
  );

  useSyncEffect(() => {
    if (!showSkillAutocomplete) return;
    setSkillAutocompleteIndex((index) => {
      if (skillAutocompleteResults.length === 0) return 0;
      return Math.min(Math.max(index, 0), skillAutocompleteResults.length - 1);
    });
  }, [showSkillAutocomplete, skillAutocompleteResults.length]);

  const selectAutocompleteItem = useCallback(
    (path: string) => {
      if (atTokenStart === null) return;
      const caret = textareaRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, atTokenStart);
      const after = value.slice(caret);
      const newValue = `${before}@${path} ${after}`;
      setValue(newValue);
      setShowAutocomplete(false);
      setAtTokenStart(null);
      setTimeout(() => {
        const element = textareaRef.current;
        if (element) {
          element.focus();
          const position = atTokenStart + path.length + 2;
          element.setSelectionRange(position, position);
        }
      }, 0);
    },
    [atTokenStart, setValue, textareaRef, value],
  );

  const selectSkillAutocompleteItem = useCallback(
    (skill: SkillMetadata) => {
      if (slashTokenStart === null) return;
      const caret = textareaRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, slashTokenStart);
      const after = value.slice(caret);
      const newValue = `${before}/${skill.name} ${after}`;
      setValue(newValue);
      setShowSkillAutocomplete(false);
      setSlashTokenStart(null);
      setTimeout(() => {
        const element = textareaRef.current;
        if (element) {
          element.focus();
          const position = slashTokenStart + skill.name.length + 2;
          element.setSelectionRange(position, position);
        }
      }, 0);
    },
    [setValue, slashTokenStart, textareaRef, value],
  );

  const handleAutocompleteKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (showSkillAutocomplete) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSkillAutocompleteIndex((index) =>
            skillAutocompleteResults.length === 0 ? 0 : Math.min(index + 1, skillAutocompleteResults.length - 1),
          );
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSkillAutocompleteIndex((index) => Math.max(index - 1, 0));
          return true;
        }
        if ((event.key === "Enter" || event.key === "Tab") && skillAutocompleteResults.length > 0) {
          event.preventDefault();
          const selectedIndex = Math.min(Math.max(skillAutocompleteIndex, 0), skillAutocompleteResults.length - 1);
          selectSkillAutocompleteItem(skillAutocompleteResults[selectedIndex]);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setShowSkillAutocomplete(false);
          return true;
        }
      }

      if (showAutocomplete) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setAutocompleteIndex((index) => Math.min(index + 1, autocompleteResults.length - 1));
          return true;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setAutocompleteIndex((index) => Math.max(index - 1, 0));
          return true;
        }
        if ((event.key === "Enter" || event.key === "Tab") && autocompleteResults.length > 0) {
          event.preventDefault();
          selectAutocompleteItem(autocompleteResults[autocompleteIndex]);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setShowAutocomplete(false);
          return true;
        }
      }

      return false;
    },
    [
      autocompleteIndex,
      autocompleteResults,
      selectAutocompleteItem,
      selectSkillAutocompleteItem,
      showAutocomplete,
      showSkillAutocomplete,
      skillAutocompleteIndex,
      skillAutocompleteResults,
    ],
  );

  const removeAttachedFile = useCallback(
    (path: string) => {
      setValue((previous) => removeAttachedFileToken(previous, path));
    },
    [setValue],
  );

  const closeAutocomplete = useCallback(() => {
    setShowAutocomplete(false);
    setShowSkillAutocomplete(false);
  }, []);

  const ensureSkillCache = useCallback(async () => {
    if (skillsCache !== null) return skillsCache;
    if (!loadSkillsRef.current) return skillsCache;
    const skills = await loadSkillsRef.current();
    setSkillsCache(skills);
    return skills;
  }, [skillsCache]);

  const ensureFileCache = useCallback(async () => {
    if (filesCache !== null) return filesCache;
    if (!loadFilesRef.current) return filesCache;
    const files = await loadFilesRef.current(reasoningEffort);
    setFilesCache(files);
    return files;
  }, [filesCache, reasoningEffort]);

  const syncScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, [highlightRef, textareaRef]);

  const fileSet = useMemo(() => (filesCache ? new Set(filesCache) : null), [filesCache]);
  const highlightedHtml = useMemo(() => buildHighlightedPromptHtml(value, fileSet), [fileSet, value]);
  const attachedFiles = useMemo(() => parseAtTokens(value, filesCache), [filesCache, value]);

  return {
    filesCache,
    skillsCache,
    showAutocomplete,
    showSkillAutocomplete,
    closeAutocomplete,
    ensureSkillCache,
    ensureFileCache,
    handleChange,
    handleSelect,
    handleAutocompleteKeyDown,
    removeAttachedFile,
    syncScroll,
    highlightedHtml,
    attachedFiles,
    viewModel: {
      showSkillAutocomplete,
      skillsLoading,
      skillsCache,
      skillAutocompleteResults,
      skillAutocompleteIndex,
      selectSkillAutocompleteItem,
      showAutocomplete,
      filesLoading,
      filesCache,
      autocompleteResults,
      autocompleteIndex,
      selectAutocompleteItem,
    },
  };
}
