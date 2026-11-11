import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);
export const initialGameLessons = ["whole-chain", "research-material-flow", "original-outcome", "observable-progress"];

export function validateGameExperienceCatalog(value) {
	if (value?.schemaVersion !== 1 || !Array.isArray(value.lessons)
		|| !value.lessons.length || value.lessons.length > 32
		|| new Set(value.lessons.map(lesson => lesson?.id)).size !== value.lessons.length
		|| JSON.stringify(value).length > 49152) throw new Error("INVALID_GAME_EXPERIENCE");
	for (const lesson of value.lessons) {
		if (!object(lesson)) throw new Error("INVALID_GAME_EXPERIENCE");
		if (!/^[a-z][a-z0-9-]{1,63}$/.test(lesson.id ?? "")
			|| ![lesson.title?.en, lesson.title?.zhCN].every(value => text(value, 160))
			|| ![lesson.guidance?.en, lesson.guidance?.zhCN].every(value => text(value, 1800))
			|| !Array.isArray(lesson.topics) || !lesson.topics.length || lesson.topics.length > 8
			|| lesson.topics.some(topic => !/^[a-z-]{1,40}$/.test(topic))
			|| !Array.isArray(lesson.sources) || !lesson.sources.length || lesson.sources.length > 4
			|| lesson.sources.some(source => !/^operations\/[a-zA-Z0-9./-]+\.md$/.test(source.path ?? "")
				|| source.path.includes("..") || !text(source.section, 160))) throw new Error("INVALID_GAME_EXPERIENCE");
	}
	return structuredClone(value);
}

export function validateGameExperienceRecord(value) {
	const source = value?.source;
	if (value?.version !== 1 || source?.repository !== "Arcueid77/Spherewright-Lab"
		|| !/^[a-f0-9]{40}$/.test(source.revision ?? "") || source.path !== "knowledge/game-agent-lessons.json"
		|| !/^[a-f0-9]{64}$/.test(source.fileSha256 ?? "")
		|| !Array.isArray(value.lessonIds) || value.lessonIds.length > 32
		|| new Set(value.lessonIds).size !== value.lessonIds.length
		|| value.lessonIds.some(id => !/^[a-z][a-z0-9-]{1,63}$/.test(id))) throw new Error("INVALID_GAME_EXPERIENCE_RECORD");
	return { version: 1, source: { repository: source.repository, revision: source.revision, path: source.path, fileSha256: source.fileSha256 }, lessonIds: [...value.lessonIds] };
}

export async function loadGameExperience() {
	const bytes = await readFile(new URL("./game-experience.bundle.json", import.meta.url));
	if (bytes.length > 65536) throw new Error("INVALID_GAME_EXPERIENCE");
	const bundle = JSON.parse(bytes.toString("utf8")), catalog = validateGameExperienceCatalog(bundle.catalog);
	if (bundle.catalogSha256 !== digest(JSON.stringify(catalog))) throw new Error("GAME_EXPERIENCE_HASH_MISMATCH");
	const record = validateGameExperienceRecord({ version: 1, source: bundle.source, lessonIds: catalog.lessons.map(lesson => lesson.id) });
	return { ...record, lessons: catalog.lessons };
}

export function gameExperienceRead(experience, args = {}) {
	if (!object(args) || Object.keys(args).some(key => !["ids", "topic"].includes(key))
		|| args.ids !== undefined && (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 4
			|| new Set(args.ids).size !== args.ids.length || args.ids.some(id => !experience.lessonIds.includes(id)))
		|| args.topic !== undefined && !/^[a-z-]{1,40}$/.test(args.topic)) throw new Error("INVALID_GAME_EXPERIENCE_QUERY");
	const lessons = experience.lessons.filter(lesson => (!args.ids || args.ids.includes(lesson.id)) && (!args.topic || lesson.topics.includes(args.topic))).slice(0, 4);
	return { source: experience.source, lessons: lessons.map(lesson => ({ id: lesson.id, title: lesson.title.zhCN, guidance: lesson.guidance.zhCN, sources: lesson.sources })) };
}

export function gameExperienceBrief(experience) {
	const index = experience.lessons.map(lesson => ({ id: lesson.id, title: lesson.title.zhCN, topics: lesson.topics }));
	const initial = initialGameLessons.filter(id => experience.lessonIds.includes(id));
	return { index, ...gameExperienceRead(experience, { ids: initial.length ? initial : experience.lessonIds.slice(0, 4) }) };
}
