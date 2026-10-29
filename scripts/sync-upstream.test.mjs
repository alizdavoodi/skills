import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-upstream.mjs");

// The script resolves its port root from its own location, so each case runs a
// copy of it inside a throwaway port tree. `git` is real; only the port is fake.
let root;
let n = 0;

before(() => {
	root = mkdtempSync(join(tmpdir(), "sync-upstream-test-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function git(args, cwd) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

// Builds an upstream repo with two commits: `pin` and `target`. `files` maps a
// path under pstack/ to its content at the pin, and `targetFiles` overrides it
// at the target. `executable` and `symlinks` shape the target commit only.
function upstream({ files, targetFiles = {}, removed = [], executable = [], symlinks = {} }) {
	const dir = join(root, `up-${n++}`);
	mkdirSync(dir, { recursive: true });
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.com"], dir);
	git(["config", "user.name", "t"], dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	git(["add", "-A"], dir);
	git(["commit", "-qm", "pin"], dir);
	const pin = git(["rev-parse", "HEAD"], dir);
	for (const [path, content] of Object.entries(targetFiles)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	for (const path of removed) rmSync(join(dir, path));
	for (const path of executable) chmodSync(join(dir, path), 0o755);
	for (const [path, to] of Object.entries(symlinks)) symlinkSync(to, join(dir, path));
	git(["add", "-A"], dir);
	git(["commit", "-q", "--allow-empty", "-m", "target"], dir);
	const target = git(["rev-parse", "HEAD"], dir);
	return { dir, pin, target };
}

function port(portFiles) {
	const dir = join(root, `port-${n++}`);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "sync-upstream.mjs"), readFileSync(SCRIPT));
	for (const [path, content] of Object.entries(portFiles)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

function run(dir, args) {
	const r = spawnSync(process.execPath, [join(dir, "scripts", "sync-upstream.mjs"), ...args], { encoding: "utf8" });
	return r;
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const has = (dir, path) => existsSync(join(dir, path));
const isExecutable = (dir, path) => (statSync(join(dir, path)).mode & 0o100) !== 0;

describe("sync-upstream", () => {
	test("keeps a port rewrite when upstream did not touch the file", () => {
		const up = upstream({ files: { "pstack/skills/how/SKILL.md": "line one\nline two\n" } });
		const p = port({ "skills/how/SKILL.md": "line one\nline two, ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(read(p, "skills/how/SKILL.md"), /ported/);
	});

	test("takes an upstream edit and keeps a port rewrite elsewhere in the file", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "alpha\nbeta\ngamma\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "alpha\nbeta changed\ngamma\n" },
		});
		const p = port({ "skills/how/SKILL.md": "alpha\nbeta\ngamma\ndelta ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		const text = read(p, "skills/how/SKILL.md");
		assert.match(text, /beta changed/, "upstream edit landed");
		assert.match(text, /delta ported/, "port addition survived");
	});

	test("reports a conflict when both sides changed the same line", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "name: how\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "name: how, rewritten upstream\n" },
		});
		const p = port({ "skills/how/SKILL.md": "name: how, rewritten for omp\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 1, "conflicts exit nonzero");
		assert.match(r.stdout, /conflict .*skills\/how\/SKILL\.md/);
		assert.ok(has(p, "skills/how/SKILL.md.merge"), "merge file written for the human");
		assert.equal(read(p, "skills/how/SKILL.md"), "name: how, rewritten for omp\n", "original untouched");
	});

	test("adopts a new upstream skill verbatim and skips port-only skills", () => {
		const up = upstream({
			files: {
				"pstack/skills/how/SKILL.md": "how\n",
				"pstack/skills/pstack-omp/SKILL.md": "upstream never had this\n",
			},
			targetFiles: { "pstack/skills/statechart/SKILL.md": "name: statechart\n" },
		});
		const p = port({ "skills/how/SKILL.md": "how\n", "skills/pstack-omp/SKILL.md": "ours\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(read(p, "skills/statechart/SKILL.md"), "name: statechart\n");
		assert.equal(read(p, "skills/pstack-omp/SKILL.md"), "ours\n", "port-only skill untouched");
	});

	test("--exclude holds a whole skill back, including new files", () => {
		const up = upstream({
			files: {
				"pstack/skills/how/SKILL.md": "how\n",
				"pstack/skills/statechart/SKILL.md": "old\n",
			},
			targetFiles: {
				"pstack/skills/how/SKILL.md": "how v2\n",
				"pstack/skills/statechart/SKILL.md": "new\n",
				"pstack/skills/statechart/scripts/run.ts": "run\n",
			},
		});
		const p = port({ "skills/how/SKILL.md": "how\n", "skills/statechart/SKILL.md": "old\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--exclude", "statechart"]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(read(p, "skills/statechart/SKILL.md"), "old\n", "held skill untouched");
		assert.ok(!has(p, "skills/statechart/scripts/run.ts"), "its new files stay out");
		assert.equal(read(p, "skills/how/SKILL.md"), "how v2\n", "other skills still sync");
	});

	test("--exclude also suppresses deletion of a held skill's files", () => {
		const up = upstream({
			files: {
				"pstack/skills/how/SKILL.md": "how\n",
				"pstack/skills/statechart/scripts/lib.mjs": "lib\n",
			},
			targetFiles: { "pstack/skills/how/SKILL.md": "how\n" },
			removed: ["pstack/skills/statechart/scripts/lib.mjs"],
		});
		const p = port({ "skills/how/SKILL.md": "how\n", "skills/statechart/scripts/lib.mjs": "lib\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--exclude", "statechart"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(has(p, "skills/statechart/scripts/lib.mjs"), "excluded skill is not reported as removed");
		assert.doesNotMatch(r.stdout, /statechart/);
	});

	test("--only syncs one skill and leaves the rest alone", () => {
		const up = upstream({
			files: {
				"pstack/skills/how/SKILL.md": "how\n",
				"pstack/skills/statechart/SKILL.md": "old\n",
			},
			targetFiles: {
				"pstack/skills/how/SKILL.md": "how v2\n",
				"pstack/skills/statechart/SKILL.md": "new\n",
				"pstack/skills/statechart/scripts/run.ts": "run\n",
			},
		});
		const p = port({ "skills/how/SKILL.md": "how\n", "skills/statechart/SKILL.md": "old\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--only", "statechart"]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(read(p, "skills/statechart/SKILL.md"), "new\n", "the named skill moves");
		assert.ok(has(p, "skills/statechart/scripts/run.ts"));
		assert.equal(read(p, "skills/how/SKILL.md"), "how\n", "every other skill is held back");
	});

	test("--only and --exclude together are refused", () => {
		const up = upstream({ files: { "pstack/skills/how/SKILL.md": "a\n" } });
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--only", "how", "--exclude", "how"]);
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /mutually exclusive/);
	});

	test("a dry run writes nothing", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /would add 0, update 1/);
		assert.equal(read(p, "skills/how/SKILL.md"), "a\n", "unchanged by a dry run");
	});

	test("reports an upstream removal without deleting the port copy", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n", "pstack/skills/gone/SKILL.md": "x\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "a\n" },
			removed: ["pstack/skills/gone/SKILL.md"],
		});
		const p = port({ "skills/how/SKILL.md": "a\n", "skills/gone/SKILL.md": "x, ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /removed upstream, kept here .*gone/);
		assert.ok(has(p, "skills/gone/SKILL.md"), "port copy kept");
	});

	test("reads an upstream clone that has no work tree", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const bare = join(root, `bare-${n++}`);
		git(["clone", "-q", "--no-checkout", up.dir, bare], root);
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", bare, "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		// Zero work would read as "the port is current", so it must see the edit.
		assert.match(r.stdout, /would add 0, update 1/);
	});

	test("reads from the clone root when --upstream names a subdirectory", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n" });
		// git resolves pathspecs against the working directory, so this used to
		// list no files and report a clean no-op.
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", join(up.dir, "pstack"), "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /would add 0, update 1/);
	});

	test("refuses a commit that has no pstack/skills", () => {
		const up = upstream({ files: { "pstack/skills/how/SKILL.md": "a\n" } });
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.target, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /same commit|no pstack\/skills/);
	});

	test("carries a mode change even when the same file conflicts", () => {
		const up = upstream({
			files: { "pstack/skills/how/run.sh": "line one\n" },
			targetFiles: { "pstack/skills/how/run.sh": "line upstream\n" },
			executable: ["pstack/skills/how/run.sh"],
		});
		const p = port({ "skills/how/run.sh": "line ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 1, "the text still needs a human");
		// The bit is independent of the text, so leaving the port's 0644 loses it.
		assert.ok(isExecutable(p, "skills/how/run.sh"), "exec bit applied despite the conflict");
	});

	test("writes nothing when the run fails partway", () => {
		const up = upstream({
			files: {
				"pstack/skills/a/SKILL.md": "a\n",
				"pstack/skills/z/SKILL.md": "z\n",
			},
			targetFiles: {
				"pstack/skills/a/SKILL.md": "a, upstream\n",
				"pstack/skills/z/SKILL.md": "z, upstream\n",
			},
			symlinks: { "pstack/skills/z-late": "SKILL.md" },
		});
		const p = port({ "skills/a/SKILL.md": "a\n", "skills/z/SKILL.md": "z\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 2, "the symlink is fatal");
		// The sort puts a/ before z-late, so a per-file write would already have landed.
		assert.equal(read(p, "skills/a/SKILL.md"), "a\n", "earlier file untouched");
	});

	test("flags a clean merge that introduces an untranslated host token", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "alpha\nbeta\n" },
			targetFiles: {
				"pstack/skills/how/SKILL.md":
					"alpha\nRead the skill under `.cursor/skills/` before work.\n",
			},
		});
		const p = port({ "skills/how/SKILL.md": "alpha\nbeta\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		// The merge is clean, so no conflict line names the file. Without this
		// flag the run reports success and the port keeps Cursor text.
		assert.match(r.stdout, /would add 0, update 1, conflict 0/);
		assert.match(r.stdout, /host .*skills\/how\/SKILL\.md \(\.cursor\//);
	});

	test("does not flag a file whose port copy already names a host on purpose", () => {
		// Enough surrounding lines that the change and the port's insertion do
		// not fall inside each other's 3-line merge context.
		const body = ["one", "two", "three", "four", "five", "six", "seven"];
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": `${body.join("\n")}\n` },
			targetFiles: {
				"pstack/skills/how/SKILL.md": `${body.map((l) => (l === "six" ? "six updated" : l)).join("\n")}\n`,
			},
		});
		// poteto-help style: the phrase is part of the port's own explanation,
		// far from the line upstream changed, so the merge is clean.
		const p = port({
			"skills/how/SKILL.md": `one\nThis repo ports a Cursor plugin from upstream.\ntwo\nthree\nfour\nfive\nsix\nseven\n`,
		});
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /would add 0, update 1/);
		assert.doesNotMatch(r.stdout, /host /);
	});

	test("requires both commits", () => {
		const p = port({});
		const r = run(p, ["--pin", "HEAD"]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /--pin and --target are required/);
	});

	test("adopts a new upstream script with its executable bit", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "how\n" },
			targetFiles: { "pstack/skills/how/scripts/run.sh": "#!/bin/sh\n" },
			executable: ["pstack/skills/how/scripts/run.sh"],
		});
		const p = port({ "skills/how/SKILL.md": "how\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(isExecutable(p, "skills/how/scripts/run.sh"), "100755 upstream stays executable here");
		assert.ok(!isExecutable(p, "skills/how/SKILL.md"));
	});

	test("applies an executable bit upstream added to an existing file", () => {
		const up = upstream({
			files: { "pstack/skills/how/scripts/run.sh": "#!/bin/sh\n" },
			executable: ["pstack/skills/how/scripts/run.sh"],
		});
		const p = port({ "skills/how/scripts/run.sh": "#!/bin/sh\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /did add 0, update 1,/);
		assert.ok(isExecutable(p, "skills/how/scripts/run.sh"));
	});

	test("keeps a file the port deleted when upstream left it alone", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n", "pstack/skills/how/references/old.md": "old\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /did add 0, update 1, conflict 0,/);
		assert.ok(!has(p, "skills/how/references/old.md"), "deletion survives the sync");
	});

	test("raises a conflict when upstream edited a file the port deleted", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n", "pstack/skills/how/references/old.md": "old\n" },
			targetFiles: { "pstack/skills/how/references/old.md": "old, edited upstream\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 1, r.stderr);
		assert.match(r.stdout, /did add 0, update 0, conflict 1,/);
		assert.match(r.stdout, /conflict .*references\/old\.md \(deleted here, changed upstream\)/);
		assert.equal(read(p, "skills/how/references/old.md.merge"), "old, edited upstream\n");
		assert.ok(!has(p, "skills/how/references/old.md"), "deletion stands until a human decides");
	});

	test("refuses to run while a .merge from an earlier run is still on disk", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n", "skills/how/SKILL.md.merge": "half resolved\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /skills\/how\/SKILL\.md\.merge/);
		assert.equal(read(p, "skills/how/SKILL.md"), "a\n", "nothing synced");
		assert.equal(read(p, "skills/how/SKILL.md.merge"), "half resolved\n", "human's edits kept");
		const dry = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--dry-run"]);
		assert.equal(dry.status, 0, "a dry run writes nothing, so it still previews");
	});

	test("rejects a pin equal to the target", () => {
		const up = upstream({ files: { "pstack/skills/how/SKILL.md": "a\n" } });
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.pin, "--upstream", up.dir]);
		assert.equal(r.status, 2);
	});

	test("rejects a target older than the pin instead of syncing backwards", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const p = port({ "skills/how/SKILL.md": "b\n" });
		const r = run(p, ["--pin", up.target, "--target", up.pin, "--upstream", up.dir]);
		assert.equal(r.status, 2);
		assert.equal(read(p, "skills/how/SKILL.md"), "b\n", "upstream edit not reverted");
	});

	test("treats a file both sides added identically as already synced", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/new/SKILL.md": "same\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n", "skills/new/SKILL.md": "same\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stdout);
		assert.match(r.stdout, /did add 0, update 0, conflict 0,/);
	});

	test("writes a .merge for a file both sides added differently", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/new/SKILL.md": "upstream\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n", "skills/new/SKILL.md": "port\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 1);
		const merge = read(p, "skills/new/SKILL.md.merge");
		assert.match(merge, /^<{7} .*\nport\n/m, "port side inside the markers");
		assert.match(merge, /^={7}\nupstream\n>{7} /m, "upstream side inside the markers");
		assert.equal(read(p, "skills/new/SKILL.md"), "port\n", "original untouched");
	});

	test("labels the sides of a conflict as port and target", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "name: how\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "name: how, upstream\n" },
		});
		const p = port({ "skills/how/SKILL.md": "name: how, omp\n" });
		run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		const merge = read(p, "skills/how/SKILL.md.merge");
		assert.match(merge, /^<{7} port$/m);
		assert.match(merge, /^>{7} target$/m);
	});

	test("copies a new binary file byte for byte", () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe, 0x0a]);
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/assets/logo.png": bytes },
		});
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(readFileSync(join(p, "skills/how/assets/logo.png")), bytes);
	});

	test("takes an upstream binary change the port never touched", () => {
		const before = Buffer.from([0x89, 0x50, 0xff, 0x00]);
		const after = Buffer.from([0x89, 0x50, 0xfe, 0x00, 0x01]);
		const up = upstream({
			files: { "pstack/skills/how/assets/logo.png": before },
			targetFiles: { "pstack/skills/how/assets/logo.png": after },
		});
		const p = port({ "skills/how/assets/logo.png": before });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stdout);
		assert.deepEqual(readFileSync(join(p, "skills/how/assets/logo.png")), after);
	});

	test("puts upstream's copy in the .merge when both sides changed a binary file", () => {
		const before = Buffer.from([0x89, 0x50, 0xff, 0x00]);
		const after = Buffer.from([0x89, 0x50, 0xfe, 0x00, 0x01]);
		const up = upstream({
			files: { "pstack/skills/how/assets/logo.png": before },
			targetFiles: { "pstack/skills/how/assets/logo.png": after },
		});
		const ours = Buffer.from([0x89, 0x50, 0xaa, 0x00]);
		const p = port({ "skills/how/assets/logo.png": ours });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 1);
		assert.deepEqual(readFileSync(join(p, "skills/how/assets/logo.png.merge")), after);
		assert.deepEqual(readFileSync(join(p, "skills/how/assets/logo.png")), ours, "original untouched");
	});

	test("rejects a symlink rather than writing its target path as file text", () => {
		const up = upstream({
			files: { "pstack/skills/how/references/real.md": "real\n" },
			symlinks: { "pstack/skills/how/references/alias.md": "real.md" },
		});
		const p = port({ "skills/how/references/real.md": "real\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /alias\.md/);
		assert.ok(!has(p, "skills/how/references/alias.md"));
	});
});
