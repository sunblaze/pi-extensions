# APOC test plan

## Objective
Create a minimal, test-only APOC with a single PR chunk so we can verify Moon Pi’s `/moon-pi next` flow end-to-end by implementing a tiny Ruby program that prints `Hello, world!`.

## PR chunks (dependency order)

### PR Chunk 1: Add a Ruby hello world program
- Scope: Add `hello_world.rb` at the repository root with a single executable Ruby script that prints `Hello, world!`.
- Risks: Very low risk; main risk is using an incorrect Ruby invocation or output text.
- Validation: Run `ruby hello_world.rb` and confirm the output is exactly `Hello, world!`.
- Human checkpoint (required before starting): Confirm we should begin PR Chunk 1 and that `hello_world.rb` is the desired filename.
