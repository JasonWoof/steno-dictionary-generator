#!/bin/bash

cd "$(dirname "$0")" || exit $?

DOCKER_IMAGE_NAME=steno-dictionary-generator:v1

if [ ! -f .docker-built -o Dockerfile -nt .docker-built ]; then
    if docker build -t "$DOCKER_IMAGE_NAME" . ; then
        touch .docker-built
    else
        exit $?
    fi
fi

exec docker run -i -t -u "$(id -u):$(id -g)" --rm -v "$(readlink -f "$(dirname "$0")")/":/opt/wd/:rw -w /opt/wd "$DOCKER_IMAGE_NAME" ./run.sh "$@"
