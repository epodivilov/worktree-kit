const VERSION = "0.1.0";

const HELP = `
worktree-kit v${VERSION}

Usage:
  wt <command> [options]

Commands:
  create <branch>   Create a new worktree with config sync
  sync              Sync config files to current worktree
  list              List all worktrees
  init              Create .worktree.json template

Options:
  --help, -h        Show this help message
  --version, -v     Show version
`;

function main() {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "--help" || command === "-h") {
		console.log(HELP);
		process.exit(0);
	}

	if (command === "--version" || command === "-v") {
		console.log(VERSION);
		process.exit(0);
	}

	switch (command) {
		case "create":
		case "sync":
		case "list":
		case "init": {
			console.log(`Command "${command}" is not implemented yet.`);
			process.exit(1);
			break;
		}
		default: {
			console.error(`Unknown command: ${command}`);
			console.log(HELP);
			process.exit(1);
		}
	}
}

main();
