FROM node:latest

RUN apt-get update && apt-get install -y espeak && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
