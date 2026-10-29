#!/usr/bin/env node
// Pulls a newer pstack release into this port without discarding the OMP rewrites.
//
// The port is not a fork with a rebasable history. It was landed as one bulk
// commit, and every shared skill carries hand edits: `skill://` URIs, `/skill:`
// prefixes, agent names, and playbook rewrites. Copying upstream over the tree
// would delete those edits, so the script merges three ways per file, with the
// recorded upstream commit as the base:
//
//   ours   = this repo's file      (port, with OMP rewrites)
//   base   = upstream at PIN       (what the port was adapted from)
//   theirs = upstream at TARGET    (the release being adopted)
//
// That keeps both sides' changes. A file no port touched becomes identical to
// upstream; a file upstream did not touch keeps the port's text. Where both
// changed the same lines, the merge stops and the file is reported as a
// conflict for a human to resolve.
//
// Usage:
//   sync-upstream.mjs --pin <sha> --target <sha> [--upstream <dir>] [--dry-run]
//   sync-upstream.mjs --pin <sha> --target <sha> --report
//
// `--upstream` points at a cursor/plugins checkout. Without it the script
// clones into a temporary directory, using the sparse pstack path.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// Skills the port owns outright, which the sync leaves alone. `setup-pstack`
// counts: upstream writes a Cursor `.mdc` rule, and this port writes OMP's
// `modelRoles` and `task.agentModelOverrides` through a script, so the two
// share a name and nothing else.
const PORT_ONLY = new Set(["fable-deslop", "orchestrate-omp", "pstack-omp", "setup-pstack"]);

// Cursor mechanisms that have no OMP equal, or a named replacement. A merged
// file that gains one needs a translation the merge itself cannot make, and a
// clean merge reports no conflict line, so the run has to point at the file.
// Deliberately narrow: prose that merely names Cursor or Bugbot while
// explaining the port is correct, so bare product words stay out.
const HOST_TOKENS =
	/\.cursor\/|\.mdc\b|subagent_type|environment: "?(cloud|local)"?|run_in_background|readonly:|generalPurpose|AskQuestion|cloud_base_branch|file_attachments|plugins\/cache|cursor-team-kit|inherit-parent/;

function git(args, options = {}) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, ...options }).trim();
}

function parseArgs(argv) {
	const args = { pin: null, target: null, upstream: null, dryRun: false, report: false, exclude: [], only: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--pin") args.pin = argv[++i];
		else if (a === "--target") args.target = argv[++i];
		else if (a === "--upstream") args.upstream = argv[++i];
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--report") args.report = true;
		else if (a === "--exclude") args.exclude.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
		else if (a === "--only") args.only.push(...String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean));
		else if (a === "--help" || a === "-h") args.help = true;
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

// A skill is synced or held back whole: a half-adopted skill whose SKILL.md and
// scripts disagree is worse than one that stays a release behind. Names match
// the skill directory, so `--exclude statechart` holds back every file under it.
// `--only` is the inverse, for one skill left behind by an earlier sync while the
// rest of the catalog moved: the pin then names that skill's own base, not the
// catalog's.
function excluded(name, { exclude, only }) {
	if (name === null) return false;
	if (only.size) return !only.has(name);
	return exclude.has(name);
}

// A commit the clone already has. A commit without the mirrored tree would list
// no files and sync nothing, which reads as "the port is current".
function resolveCommit(rev, clone) {
	let sha;
	try {
		sha = git(["-C", clone, "rev-parse", `${rev}^{commit}`]);
	} catch {
		throw new Error(`cannot resolve ${rev} in ${clone}`);
	}
	try {
		git(["-C", clone, "cat-file", "-e", `${sha}:pstack/skills`]);
	} catch {
		throw new Error(`${rev} has no pstack/skills in ${clone}`);
	}
	return sha;
}

function isAncestor(clone, older, newer) {
	try {
		git(["-C", clone, "merge-base", "--is-ancestor", older, newer]);
		return true;
	} catch (err) {
		if (err.status === 1) return false;
		throw err;
	}
}

function ensureCheckout(upstream) {
	// git reads pathspecs relative to the directory it runs in, so a checkout
	// pointed at a subdirectory matches nothing. Only commits are read, so the
	// clone needs no work tree; work from its root either way.
	if (upstream) return { dir: git(["-C", upstream, "rev-parse", "--show-toplevel"]), temporary: false };
	const dir = mkdtempSync(join(tmpdir(), "pstack-sync-"));
	try {
		git(["clone", "--filter=blob:none", "--no-checkout", "--quiet", "https://github.com/cursor/plugins", dir]);
	} catch (err) {
		rmSync(dir, { recursive: true, force: true });
		throw err;
	}
	return { dir, temporary: true };
}

// Every mirrored file at a commit, keyed by repository-relative path under pstack/.
function listFiles(clone, commit) {
	const files = new Map();
	const out = git(["-C", clone, "ls-tree", "-r", "-z", commit, "--", "pstack/skills", "pstack/agents"]);
	for (const entry of out.split("\0").filter(Boolean)) {
		const [meta, path] = entry.split("\t");
		const [mode, , sha] = meta.split(" ");
		// A symlink's blob is its target path; written out, it would become a
		// regular file holding that path.
		if (mode !== "100644" && mode !== "100755") throw new Error(`${path} has mode ${mode} at ${commit}; only regular files can be synced`);
		files.set(path, { sha, exec: mode === "100755" });
	}
	return files;
}

// Raw bytes. The `git()` helper decodes and trims: a merge base missing its
// final newline makes every file look edited at its last line, and decoding
// replaces every non-UTF-8 byte of a binary file.
function readAt(clone, sha) {
	return execFileSync("git", ["-C", clone, "cat-file", "blob", sha], { maxBuffer: 64 << 20 });
}

// `.merge` files the port still holds, as paths relative to the port root.
function pendingMerges() {
	return ["skills", "agents"]
		.filter((d) => existsSync(join(REPO, d)))
		.flatMap((d) => readdirSync(join(REPO, d), { recursive: true }).map((f) => join(d, f)))
		.filter((f) => f.endsWith(".merge"));
}

function skillName(path) {
	const parts = path.split("/");
	return parts[0] === "pstack" && parts[1] === "skills" ? parts[2] : null;
}

function portPath(path) {
	return join(REPO, path.replace(/^pstack\//, ""));
}

// git merge-file wants three files, and writes its result back to the first.
// Exit 0 is a clean merge, a positive count is the number of conflicts.
// `text` is null when git refuses to merge, as it does for binary files.
function mergeThreeWay(ours, base, theirs) {
	const dir = mkdtempSync(join(tmpdir(), "pstack-merge-"));
	const out = join(dir, "ours");
	writeFileSync(out, ours);
	writeFileSync(join(dir, "base"), base);
	writeFileSync(join(dir, "theirs"), theirs);
	try {
		// `-p` prints the merge to stdout and leaves `out` untouched, so the
		// stdout capture is the merged text in both outcomes.
		const args = ["merge-file", "-p", "-L", "port", "-L", "pin", "-L", "target", out, join(dir, "base"), join(dir, "theirs")];
		const text = execFileSync("git", args, { maxBuffer: 64 << 20, stdio: "pipe" });
		return { clean: true, text };
	} catch (err) {
		// git caps the conflict count at 127 and reports its own errors as 255.
		if (err.status > 0 && err.status < 128) return { clean: false, text: err.stdout };
		if (err.status === 255) return { clean: false, text: null };
		throw err;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Host tokens present in the merged text that were not in the port's copy.
// Those are the lines upstream just delivered, so they are the ones that may
// need a translation the port has not made yet.
function newHostTokens(merged, ours) {
	const before = new Set((ours.toString("utf8").match(new RegExp(HOST_TOKENS, "g")) ?? []).map((s) => s.toLowerCase()));
	const seen = new Set();
	for (const match of merged.toString("utf8").matchAll(new RegExp(HOST_TOKENS, "g"))) {
		const token = match[0].toLowerCase();
		if (!before.has(token)) seen.add(match[0]);
	}
	return [...seen];
}

function main(argv) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log("usage: sync-upstream.mjs --pin <sha> --target <sha> [--upstream <dir>] [--exclude <skill,...> | --only <skill,...>] [--dry-run] [--report]");
		return;
	}
	if (!args.pin || !args.target) throw new Error("--pin and --target are required");
	const excludes = new Set(args.exclude);
	const filters = { exclude: excludes, only: new Set(args.only) };
	if (args.exclude.length && args.only.length) throw new Error("--exclude and --only are mutually exclusive");

	const { dir, temporary } = ensureCheckout(args.upstream);
	try {
		const pin = resolveCommit(args.pin, dir);
		const target = resolveCommit(args.target, dir);
		if (pin === target) throw new Error(`--pin and --target are the same commit ${pin}`);
		// Merging toward an older commit would revert every upstream change in between.
		if (!isAncestor(dir, pin, target)) throw new Error(`--pin ${pin} is not an ancestor of --target ${target}`);

		if (args.report) {
			const changed = git(["-C", dir, "diff", "--name-only", pin, target, "--", "pstack/skills", "pstack/agents"]);
			const added = git(["-C", dir, "diff", "--name-status", pin, target, "--", "pstack/skills"]);
			console.log(`pin:    ${pin}`);
			console.log(`target: ${target}`);
			console.log("\nchanged files:");
			for (const line of changed.split("\n").filter(Boolean)) console.log(`  ${line}`);
			const additions = added.split("\n").filter((l) => l.startsWith("A\t"));
			if (additions.length) {
				console.log("\nnew skills:");
				for (const line of additions) {
					const name = skillName(line.split("\t")[1]);
					if (!name) continue;
					console.log(`  ${name}${excluded(name, filters) ? " (held back)" : ""}`);
				}
			}
			return;
		}

		// A leftover .merge is an unfinished resolution: a rerun would overwrite
		// the human's edits in it, or leave it for `git add -A` to commit.
		if (!args.dryRun) {
			const pending = pendingMerges();
			if (pending.length) throw new Error(`resolve and delete these .merge files first:\n  ${pending.join("\n  ")}`);
		}

		const pinFiles = listFiles(dir, pin);
		const targetFiles = listFiles(dir, target);

		const added = [];
		const updated = [];
		const conflicts = [];
		const removed = [];

		// Writes are planned, then applied once every file has been planned. A
		// failure partway through would otherwise leave the port half-synced.
		const writes = [];
		const modes = new Map();
		const hostFlags = [];

		function conflict(path, reason, text, exec = null) {
			conflicts.push({ path, reason });
			writes.push([`${portPath(path)}.merge`, text, null]);
			// A mode change is independent of the text, so a conflict does not
			// suspend it. Dropping it here loses the bit until someone notices.
			if (exec !== null) modes.set(portPath(path), exec);
		}

		for (const path of [...targetFiles.keys()].sort()) {
			const name = skillName(path);
			if (name && PORT_ONLY.has(name)) continue;
			if (excluded(name, filters)) continue;

			const theirs = targetFiles.get(path);
			const base = pinFiles.get(path);
			const oursFile = portPath(path);
			const hasOurs = existsSync(oursFile);

			// New upstream file: adopt verbatim, since no port edit exists to keep.
			if (!hasOurs && !base) {
				added.push(path);
				writes.push([oursFile, readAt(dir, theirs.sha), theirs.exec]);
				continue;
			}

			// The port deleted this file on purpose. Only an upstream edit since the
			// pin reopens that decision, and only a human can make it.
			if (!hasOurs) {
				if (base.sha !== theirs.sha) conflict(path, "deleted here, changed upstream", readAt(dir, theirs.sha));
				continue;
			}

			const ours = readFileSync(oursFile);
			const oursMode = statSync(oursFile).mode & 0o7777;
			const oursExec = (oursMode & 0o100) !== 0;
			// The port's mode stands unless upstream flipped the bit since the pin.
			const exec = base?.exec === theirs.exec ? oursExec : theirs.exec;

			let text = ours;
			if (base?.sha !== theirs.sha) {
				// With no base at the pin, both sides added the file: an empty base
				// makes identical copies merge clean and different ones conflict.
				const baseText = base ? readAt(dir, base.sha) : Buffer.alloc(0);
				const theirsText = readAt(dir, theirs.sha);
				// An untouched port copy takes upstream outright, which git merge-file
				// would refuse for a binary file.
				// Identical on both sides is already in sync, and a change both sides
				// made is the same edit arriving twice. Neither needs merge-file,
				// which refuses binary content outright.
				const merged =
					ours.equals(baseText) || ours.equals(theirsText)
						? { clean: true, text: theirsText }
						: mergeThreeWay(ours, baseText, theirsText);
				if (!merged.clean && !merged.text) {
					conflict(path, "binary, changed on both sides", theirsText, exec === oursExec ? null : exec);
					continue;
				}
				if (!merged.clean) {
					const hunks = (merged.text.toString("utf8").match(/^<{7} /gm) ?? []).length;
					conflict(path, `${hunks} conflict hunk(s)`, merged.text, exec === oursExec ? null : exec);
					continue;
				}
				text = merged.text;
			}
			if (text.equals(ours) && exec === oursExec) continue;
			updated.push(path);
			writes.push([oursFile, text, exec === oursExec ? null : exec]);
			// Only tokens the port file did not already carry. A file that keeps
			// its own translated wording is fine even if it mentions Cursor.
			const fresh = newHostTokens(text, ours);
			if (fresh.length) hostFlags.push({ path, tokens: fresh });
		}

		for (const path of [...pinFiles.keys()].sort()) {
			if (targetFiles.has(path)) continue;
			const name = skillName(path);
			if (name && PORT_ONLY.has(name)) continue;
			if (excluded(name, filters)) continue;
			if (existsSync(portPath(path))) removed.push(path);
		}

		if (!args.dryRun) {
			for (const [file, bytes, exec] of writes) {
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, bytes);
				// Only the executable bit is git's to record; the rest is the port's umask.
				if (exec !== null) {
					const mode = statSync(file).mode & 0o7777;
					chmodSync(file, exec ? mode | ((mode & 0o444) >> 2) : mode & ~0o111);
				}
			}
			for (const [file, exec] of modes) {
				const mode = statSync(file).mode & 0o7777;
				chmodSync(file, exec ? mode | ((mode & 0o444) >> 2) : mode & ~0o111);
			}
		}

		const verb = args.dryRun ? "would" : "did";
		console.log(`pin:    ${pin}`);
		console.log(`target: ${target}`);
		console.log(`\n${verb} add ${added.length}, update ${updated.length}, conflict ${conflicts.length}, upstream-removed ${removed.length}`);
		for (const path of added) console.log(`  add      ${path}`);
		for (const path of updated) console.log(`  update   ${path}`);
		for (const c of conflicts) console.log(`  conflict ${c.path} (${c.reason})${args.dryRun ? "" : ", see .merge"}`);
		for (const path of removed) console.log(`  removed upstream, kept here ${path}`);

		if (hostFlags.length) {
			console.log("\nhost mechanisms the port has not translated:");
			for (const f of hostFlags) console.log(`  host     ${f.path} (${f.tokens.join(", ")})`);
			console.log("\nSee skill://pstack-omp/references/host-translation.md. A clean merge still carries new upstream lines verbatim.");
		}

		if (conflicts.length && !args.dryRun) {
			console.log("\nResolve each .merge file, then delete it. A conflict means both sides changed the same line.");
			process.exitCode = 1;
		}
	} finally {
		if (temporary) rmSync(dir, { recursive: true, force: true });
	}
}

try {
	main(process.argv.slice(2));
} catch (err) {
	console.error(`sync-upstream: ${err.message}`);
	process.exit(2);
}
