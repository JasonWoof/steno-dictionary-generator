# algorithm-generated steno dictionary

This project is designed to answer the question "Can we make a decent
stenography dictionary with an algorithm and free data?

# Status

Status: very early development stages.

Currently it just parses a wiktionary dump gets pronunciations from espeak (no steno anything yet).

# How To Run It

Option 1: install docker, then run: `./run-in-docker.sh -i enwiktionary.xml.bz2 -o output.ndjson`

Option 2: install node.js and espeak, then run: `./run.sh -i enwiktionary.xml.bz2 -o output.ndjson`
