#!/usr/bin/node

"use strict";

// handle init process signals in case we're running in docker
process.on('SIGINT', () => {
    console.log('received SIGINT, exiting');
    process.exit();
});
process.on('SIGTERM', () => {
    console.log('received SIGTERM, exiting');
    process.exit();
});

const
    fs = require('fs'),
    stream = require('stream'),
    readline = require('readline'),
    child_process = require('child_process'),
    sax = require("sax"),
    unbzip2_stream = require('unbzip2-stream')
;


// A Transform stream. write/pipe normal data to it (not object mode) and outputs lines (object mode)
const xml_to_pages = () => {
    const parser = sax.createStream(true, {
        lowercase: true,
        position: false,
        normalize: false,
        strictEntities: true,
    });
    const done = manual_promise();
    const transform = new stream.Transform({
        readableObjectMode: true,
        transform (chunk, encoding, cb) {
            if (parser.write(chunk)) {
                cb();
            } else {
                parser.once('drain', cb);
            }
        },
        flush (cb) {
            parser.end();
            done.then(cb);
        },
    });

    let page = null
    let text = ''
    let ns = null
    parser.on('error', (err) => transform.emit('error', err));
    parser.on('text', (t) => text += t);
    parser.on('opentag', (t) => {
        text = '';
        if (t.name === 'page') {
            page = { title: '', text: '' };
            ns = null;
        }
    });
    parser.on('closetag', (name) => {
        var full;
        if (name === 'page') {
            if (ns === '0') {
                transform.push(page); // do I need to handle backpressure here? Transform should do it for me
            }
        } else if (name === 'ns') {
            ns = text;
        } else if (name === 'title') {
            page.title = text;
        } else if (name === 'text') {
            page.text = text;
        }
        text = '';
    });
    parser.on('end', () => done.resolve());
    return transform;
};





// usage:
// const p = manual_promise();
// timeout(1).then(() => p.then(foo));
// timeout(2).then(() => p.resolve());
// timeout(3).then(() => p.then(bar));
const manual_promise = () => {
    let res, rej;
    const promise = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
    });
    promise.resolve = res;
    promise.reject = rej;
    return promise;
}

// TODO try pumpify instead
const pipeline = (...args) => {
    const first = args[0];
    const last = args[args.length - 1];
    const done = manual_promise();
    const transform = new stream.Transform({
        writeableObjectMode: first._writableState ? first._writableState.objectMode : false,
        readableObjectMode: last._readableState ? last._readableState.objectMode : false,
        transform: (chunk, encoding, cb) => {
            if (first.write(chunk)) {
                cb();
            } else {
                first.once('drain', cb);
            }
        },
        flush: (cb) => {
            first.end();
            done.then(cb);
        },
    });
    last.on('data', (chunk) => {
        if (!transform.push(chunk)) {
            first.pause();
        }
    });
    transform.on('drain', () => {
        first.resume();
    });
    last.on('end', () => {
        done.resolve();
    });
    last.on('error', (err) => transform.emit('error', err));
    stream.pipeline(...args, (err) => {
        if (err) {
            transform.emit('error', err);
        }
    });
    return transform;
};

// A Transform stream. write/pipe normal data to it (not object mode) and outputs lines (object mode)
const split_lines = () => {
    // readline module requires an input stream as an argument, you can't just
    // pipe() to it, so create a stream we can pass
    const splitter_input = new stream.PassThrough();
    const splitter = readline.createInterface({
        input: splitter_input,
        output: null,
        crlfDelay: Infinity
    });
    const done = manual_promise();
    const transform = new stream.Transform({
        readableObjectMode: true,
        transform (chunk, encoding, cb) {
            if (splitter_input.write(chunk)) {
                cb();
            } else {
                splitter_input.once('drain', cb);
            }
        },
        flush (cb) {
            splitter_input.end();
            done.then(cb);
        },
    });
    splitter.on('line', (line) => transform.push(line));
    splitter.on('close', () => done.resolve());
    return transform;
};

// simple: no flush, no async
// return value to push
// throw to cb(err)
const simple_object_transform = (transformer) => new stream.Transform({
    objectMode: true,
    transform(chunk, encoding, cb) {
        try {
            const ret = transformer(chunk);
            if (ret != null) {
                this.push(ret)
            }
            cb();
        } catch (err) {
            cb(err);
        }
    },
});

const lines_to_json = () => simple_object_transform((chunk) => JSON.parse(chunk.toString('utf8')));

const batch = (size) => {
    let next_batch = [];
    return new stream.Transform({
        objectMode: true,
        transform (chunk, encoding, cb) {
            next_batch.push(chunk);
            if (next_batch.length == size) {
                this.push(next_batch);
                next_batch = [];
            }
            cb();
        },
        flush (cb) {
            if (next_batch.length) {
                this.push(next_batch);
                next_batch = [];
            }
            cb();
        },
    });
}

const extract_english_titles = () => simple_object_transform((page) => {
    if (page.text.indexOf('==English==') > -1 && !/^[-0-9,$.]*$/.test(page.title)) {
        return page.title;
    }
});
const to_ndjson = () => simple_object_transform((chunk) => `${JSON.stringify(chunk)}\n`);

const espeak_pronunciations = () => new stream.Transform({
    objectMode: true,
    transform(words, encoding, cb) {
        const input_text = words.join("\n").replace(/[,.;!?]/g, '');
        const espeak = child_process.spawn('espeak', ['-qx']); // --stdin in arg is bugged, works without
        try {
            espeak.stdin.end(input_text);
        } catch (err) {
            // we'll get an error event, so no need to react here
        }
        let output = '';
        let error = '';
        espeak.stdout.on('data', (data) => {
            output += data.toString();
        });
        espeak.stderr.on('data', (data) => {
            error += data.toString();
        });
        espeak.on('error', cb);
        espeak.on('exit', (exit_code) => {
            if (exit_code !== 0) {
                return cb(new Error(`espeak exit code ${exit_code} message: ${error}`));
            }
            const pronunciations = output.trim().split("\n");
            if (pronunciations.length != words.length) {
                return cb(new Error(`espeak returned ${pronunciations.length} pronunciations for ${words.length} words. input: ${input_text}, output: ${output}`));
            }
            words.forEach((word, i) => this.push({word, pronunciation: pronunciations[i].trim()}));
            cb();
        });
    },
});


const parse_argv = (argv) => {
    const ret = {
        input: process.stdin,
        output: process.stdout,
        limit: Infinity,
    };
    for (let i = 2; i < argv.length; ++i) {
        const a = argv[i];
        if (a === '-i') {
            console.log(`reading from ${argv[i + 1]}`);
            ret.input = fs.createReadStream(argv[i + 1]);
            i += 1;
        } else if (a === '-o') {
            console.log(`writing to ${argv[i + 1]}`);
            ret.output = fs.createWriteStream(argv[i + 1]);
            i += 1;
        } else if (a === '-l') {
            ret.limit = parseInt(argv[i + 1]);
            i += 1;
        } else {
            throw new Error(`unrecognized commandline argument ${a}`);
        }
    }
    return ret;
}

const argv = parse_argv(process.argv);

const parser = pipeline(
    argv.input,
    //split_lines(),
    //lines_to_json(),
    unbzip2_stream(),
    xml_to_pages(),
    extract_english_titles(),
    batch(400),
    espeak_pronunciations(),
    to_ndjson(),
);

parser.on('error', (err) => console.log('error propagated to top level!', err));
let output_count = 0;
console.log('reporting progress every 1000');
parser.on('data', (data) => {
    if (output_count < argv.limit) {
        if (argv.output.write(data) === false) {
            argv.input.pause();
        }
        output_count += 1;
        if (output_count % 1000 === 0) {
            console.log(`output ${output_count}`);
        }
        if (output_count === argv.limit) {
            argv.input.close();
        }
    }
});
argv.output.on('drain', () => argv.input.resume());
