# Changelog


## Features

- add isDirectory and copyDirectory to FilesystemPort
- support directory copying in copy config
- add glob method to FilesystemPort
- support glob patterns in copy config

## Features

- add defaultBase config and source branch support
- implement getDefaultBranch and baseBranch in worktree creation
- pass baseBranch through to git and update init defaults
- prompt for source branch when creating new branch

## Miscellaneous

- release v0.1.4

## Testing

- add tests for defaultBase schema validation

## Features

- use wt-preview command instead of replacing wt
- add main and current badges to worktree list
- prompt to remove empty worktrees directory after last worktree removed
- show remote branches when creating worktree
- add "Remove all" option to remove command
- move "Create new branch" option to top of branch list
- sort branches by commit date (newest first)
- group remote branches in separate submenu
- automate release workflow with git-cliff

## Miscellaneous

- add *.local pattern to gitignore
- release v0.1.3

## Bug Fixes

- read version from package.json instead of hardcoded value
- safely remove only dev symlinks in clean script

## Features

- add progress spinner to remove command
- prompt to delete branch when removing worktree

## Miscellaneous

- bump version to 0.1.2

## Documentation

- add GitHub Sponsors funding configuration

## Features

- add interactive mode to create command

## Miscellaneous

- bump version to 0.1.1

## Documentation

- add README and project instructions
- update README to match current implementation

## Features

- add CLI entrypoint with basic routing
- add runtime dependencies
- add Result type for error handling
- add domain layer with entities, ports, and schemas
- add infrastructure layer with adapters and container
- add application layer with use case stubs
- wire CLI commands with citty and composition root
- add test utilities and fakes for unit testing
- replace config schema with rootDir and copy fields
- implement loadConfig and initConfig use cases
- implement Git adapter worktree operations
- implement listWorktrees use case
- add preview and clean scripts for local CLI publishing
- implement createWorktree use case
- add select method to UiPort
- implement removeWorktree use case
- add remove command to CLI
- add branchExists method and support new branch creation in worktrees
- add notification system for use case feedback
- warn when config not found in wt create
- show worktree path in create success message
- read config from main worktree instead of current directory
- add ShellPort interface for command execution
- add hooks configuration to config schema
- add hooks property to WorktreeConfig entity
- add runHooks use case for post-create commands
- add BunShellAdapter for command execution
- run post-create hooks after worktree creation
- wire ShellPort into container and create command
- add SpinnerHandle interface to UiPort
- implement createSpinner in ClackUiAdapter
- add progress spinners to create command
- add LoggerPort interface for verbose logging
- add ConsoleLoggerAdapter for verbose output
- wire LoggerPort into container and adapters
- add --verbose flag and WT_VERBOSE env support
- add release build script and GitHub workflow
- add installation scripts for all platforms

## Miscellaneous

- initial project setup

## Refactoring

- return data instead of executing in createWorktree

## Testing

- add unit tests across all layers
- add FakeShell test utility
- add noop logger for adapter tests
