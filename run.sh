#!/bin/bash

cd "$(dirname "$0")" || exit $?

if [ ! -f .npm-built -o package.json -nt .npm-built ]; then
    if npm install ; then
        touch .npm-built
    else
        exit $?
    fi
fi

node index.js "$@"
