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

// TODO extract pronunciations too
// prioritize american, and get multiple: https://en.wiktionary.org/wiki/jalape%C3%B1o
const extract_english_titles = () => simple_object_transform((page) => {
    if (page.text.indexOf('==English==') > -1 && !/^[-0-9,$.]*$/.test(page.title)) {
        return page.title;
    }
});
const to_ndjson = () => simple_object_transform((chunk) => `${JSON.stringify(chunk)}\n`);

const espeak_pronunciations = () => new stream.Transform({
    objectMode: true,
    transform(words, encoding, cb) {
        const input_text = words.join("\n").replace(/[,.;!?…]/g, '');
        const env = Object.assign({}, process.env);
        env.LANG = env.LC_ALL = "en_us.UTF-8";
        const espeak = child_process.spawn('espeak', ['-qx', '-b1', '-v', 'en-us', '--ipa'], {env: env}); // --stdin in arg is bugged but  it's the default so don't pass that arg. --ipa arg must be after -x
        try {
            espeak.stdin.end(input_text);
        } catch (err) {
            // we'll get an error event, so no need to react here
        }
        let output = [];
        let error = '';
        espeak.stdout.on('data', (data) => {
            output.push(data);
        });
        espeak.stderr.on('data', (data) => {
            error += data.toString();
        });
        espeak.on('error', cb);
        espeak.on('exit', (exit_code) => {
            if (exit_code !== 0) {
                return cb(new Error(`espeak exit code ${exit_code} message: ${error}`));
            }
            const pronunciations = Buffer.concat(output).toString().trim().split("\n");
            if (pronunciations.length != words.length) {
                return cb(new Error(`espeak returned ${pronunciations.length} pronunciations for ${words.length} words. input: ${input_text}, output: ${output}`));
            }
            words.forEach((word, i) => this.push({word, espeak: pronunciations[i].trim()}));
            cb();
        });
    },
});

const
    STRESS_UN = 0,
    STRESS_LOW = 1,
    STRESS_NORMAL = 2,
    STRESS_SECONDARY = 3,
    STRESS_FULL = 4;

// score guide:
// 1.0: perfect match
// 0.9: eg best stroke for the sound, but not the best sound for the stroke
// 0.7: meh
// 0.3: last-ditch effort if everything conflicts

// stroke definitions:
//
// lowercase means right-hand-side
//
const steno_order = 'STKPWHRAO*EUfrpblgts';

// put the longer ones first
const [phoneme_to_keys_map, longest_phoneme] = ((merged) => {
    // unmerge phonemes
    const all_phonemes = [];
    let longest_phoneme = 0;
    for (let i = 0; i < merged.length; i += 2) {
        const phonemes = merged[i];
        const outputs = merged[i + 1]
        for (const phoneme of phonemes) {
            longest_phoneme = Math.max(longest_phoneme, phoneme.length);
            all_phonemes.push([phoneme, outputs]);
        }
    }
    return [new Map(all_phonemes), longest_phoneme];
})([
    // FIXME Either drop enPR or distinguish it, there's at least one conflict with IPA ("j")

    // ah: father, palm
    ['ɑː', 'ɑ', 'ä',], [
        {keys: 'A', score: 0.9}, // best keys for this sound, but not the best sound for this keys
        {keys: 'AU', score: 0.5},
    ],

    // a: bad, cat, ran
    ['æ', 'æː', 'ɛə', 'a', 'ă'], [
        {keys: 'A', score: 1},
    ],

    // ay: day, pain, heY, weight
    ['eɪ', 'ɛi', 'ā'], [
        {keys: 'AEU', score: 1},
    ],

    // eh: bed, egg, meadow
    ['ɛ', 'ĕ', 'eː', 'e'], [ // eː and e could use confirmation
        {keys: 'E', score: 1},
    ],

    // eh?
    ['eː', 'e'], [
        {keys: 'E', score: 0.8},
    ],

    // ee: ease, see, siege, ceiling
    ['i', 'iː', 'ɪi', 'ē'], [
        {keys: 'AOE', score: 1},
    ],

    // ee eh dipthong: canadIAn
    ['iə'] , [
        {keys: 'KWRA', score: 0.82},
        {keys: 'KWRE', score: 0.72},
    ],

    // ee?: citY, everYday, manIa, gEography
    // FIXME espeak doesn't produce: ['ɪː'], what soeund does it make?

    // ih: sit, city, bit, will
    ['ɪ', 'ĭ'], [
        {keys: 'EU', score: 1},
    ],
    // TODO ['ɨ', 'ih'], // quicker, but still "ih" like rosEs // maybe make optional leave it out?

    // my, rice, pie, hi, Mayan
    ['aɪ', 'ɑi', 'ī'], [
        {keys: 'AOEU', score: 1},
    ],

    // awe: maw baught caught
    ['ɔ'], [
        {keys: 'AU', score: 1},
        {keys: 'O', score: 0.8},
    ],

    // About, brAzil  "uh" sound (but slightly "ah"-like) usually spelled with an A
    ['ɐ'], [
        {keys: 'U', score: 0.9}, // best for sound, not best sound for keys
        {keys: 'A', score: 0.8},
        {keys: 'AU', score: 0.5},
    ],

    // TODO ['ɒ', ''] espeak doesn't produce this for en-us maybe it's found in wiktionary, figure out what it sounds like

    // TODO ['ŏ', 'ah'], // TODO what sound is this?

    // no, go, hope, know, toe
    ['əʊ', 'oʊ', 'ō'], [
        {keys: 'OE', score: 1},
        {keys: 'O', score: 0.3},
    ],

    // o: hoarse, force // espeak only has this before "ɹ"
    // TODO wiktionary might use "oː" for "awe"
    ['oː', 'ō'], [
        {keys: 'O', score: 1},
        {keys: 'AU', score: 0.7},
    ],

    // espeak uses this for both "awe" as in "draw" and "o" as in "north"
    // TODO see how wiktionary uses it
    ['ɔː'], [
        {keys: 'AU', score: 0.8},
        {keys: 'O', score: 0.8},
    ],

    //law, caught
    // ɔː, oː	ɔ, ɒ	ɒ	oː	ô
    // TODO is ô "awe" or "o as in Or"?
    // (ɔə) ɔː, oː	ɔɹ	oː	ôr	horse, north[5]

    // oi: boy, noise
    ['ɔɪ', 'oi', 'ɔɪ'], [
        {keys: 'OEU', score: 1},
    ],

    // u: put, foot, wolf
    ['ʊ', 'o͝o', 'ŏŏ'], [
        // this sound doesn't map well...
        {keys: 'AO', score: 0.7},
        {keys: 'O', score: 0.6},
        {keys: 'U', score: 0.5},
    ],

    // TODO figure out 'ɵː' sound if wiktionary uses it

    // oo: lose, soon, through
    ['uː', 'ʉː', 'u', 'o͞o', 'ōō'], [
        {keys: 'AO', score: 1},
    ],

    // ow: house, now, tower
    ['aʊ', 'ʌʊ', 'ou'], [
        {keys: 'OU', score: 1},
    ],

    // uh: run, enough, up, other
    ['ʌ', 'ŭ'], [
        {keys: 'U', score: 1},
    ],

    // r: fur, blurry, bird, swerve[11][12]
    ['ɜː', 'ɝ', 'ûr'], [
        {keys: 'r', score: 0.9},
        {keys: 'R', score: 0.8},
        {keys: 'Ur', score: 0.7},
    ],

    // uh/ah: rosA's, About, Oppose
    ['ə'], [
        {keys: 'U', score: 0.85},
        {keys: 'AU', score: 0.66},
        {keys: 'O', score: 0.57},
        {keys: 'A', score: 0.51},
    ],

    // r: winnER, entER, errOR, doctOR
    ['ɚ', 'ər'], [
        {keys: 'R', score: 0.9},
        {keys: 'r', score: 0.91},
        {keys: 'Ur', score: 0.7},
    ],


    // schwa: dEcember
    ['ᵻ'], [
        {keys: 'U', score: 0.63},
        {keys: '', score: 0.88},
        {keys: 'E', score: 0.33},
        {keys: 'EU', score: 0.32},
        {keys: 'A', score: 0.31},
    ],

    // croissant (french vowel at the end)
    ['ɑ̃', 'ɔ̃'], [
        {keys: 'OE', score: 0.76},
        {keys: 'AU', score: 0.66},
    ],

    // consonants
    // b: but, web, rubble
    ['b'], [
        {keys: 'PW', score: 1},
        {keys: 'b', score: 1},
    ],

    // ch: chat, teach, nature
    // FIXME why doesn't "premature" match this?
    ['t͡ʃ', 'ch'], [
        {keys: 'KH', score: 1},
        {keys: 'fp', score: 0.9},
    ],

    // d: dot, idea, nod
    ['d'], [
        {keys: 'TK', score: 1},
        {keys: 'd', score: 1},
    ],

    // f: fan, left, enough, photo
    ['f'], [
        {keys: 'TP', score: 1},
        {keys: 'f', score: 1},
    ],

    // g: get, bag
    ['ɡ', 'g'], [
        {keys: 'TKPW', score: 1},
        {keys: 'g', score: 1},
    ],

    // h: ham
    ['h'], [
        {keys: 'H', score: 1},
    ],

    // wh: which
    ['ʍ', 'hw'], [
        {keys: 'WH', score: 1},
    ],

    // j: joy, agile, age
    ['d͡ʒ', 'dʒ'], [
        {keys: 'SKWR', score: 1},
        {keys: 'KWR', score: 0.2},
    ],

    // k: cat, tack
    ['k'], [
        {keys: 'K', score: 1},
        {keys: 'bg', score: 1},
    ],

    // kh: loCH (in Scottish English)
    ['x', 'ᴋʜ'], [
        {keys: 'K', score: 0.69},
        {keys: 'KH', score: 0.65},
        {keys: 'bg', score: 0.79},
        {keys: 'fp', score: 0.72},
    ],

    // l: left
    ['l', 'ɫ'], [
        {keys: 'HR', score: 1},
        {keys: 'l', score: 1},
    ],

    // little
    ['l̩', 'əl'], [
        {keys: 'HR', score: 1},
        {keys: 'l', score: 1},
        {keys: 'El', score: 0.58},
    ],

    // m: man, animal, him
    ['m'], [
        {keys: 'PH', score: 1},
        {keys: 'pl', score: 0.95},
    ],

    // m: spasm, prism
    ['m̩', 'əm'], [
        {keys: 'PH', score: 1},
        {keys: 'pl', score: 0.95},
        {keys: 'Epl', score: 0.55},
    ],

    // n: note, ant, pan
    ['n'], [
        {keys: 'TPH', score: 1},
        {keys: 'pb', score: 1},
    ],

    // n: hidden
    ['n̩', 'ən'], [
        {keys: 'TPH', score: 1},
        {keys: 'pb', score: 1},
        {keys: 'Epb', score: 0.56},
    ],

    // ng: singer, ring
    ['ŋ', 'ng'], [
        {keys: 'pbg', score: 1},
    ],

    // p: pen, spin, top, apple
    ['p'], [
        {keys: 'P', score: 1},
        {keys: 'p', score: 1},
    ],

    // r: run, very
    ['ɹ', 'r'], [
        {keys: 'R', score: 1},
        {keys: 'r', score: 1},
    ],

    // s: set, list, ice
    ['s'], [
        {keys: 'S', score: 1},
        {keys: 'f', score: 0.7},
        {keys: 's', score: 1},
        {keys: 'z', score: 0.81},
    ],

    // sh: ash, sure, ration
    ['ʃ', 'sh'], [
        {keys: 'SH', score: 1},
        {keys: 'rb', score: 1},
    ],

    // t: ton, butt
    ['t', 'ɾ', 'ʔ'], [
        {keys: 'T', score: 1},
        {keys: 't', score: 1},
    ],

    // th: thin, nothing, moth
    ['θ', 'th'], [
        {keys: 'TH', score: 1},
        {keys: '*t', score: 0.9},
    ],

    // voiced th: this, father, clothe
    ['ð', 'th'], [
        {keys: 'TH', score: 0.99},
        {keys: '*t', score: 0.89},
    ],

    // v: voice, navel
    ['v'], [
        {keys: 'SR', score: 1},
        {keys: 'f', score: 0.6},
    ],

    // w: wet
    ['w'], [
        {keys: 'W', score: 1},
    ],

    // y: yes
    ['j', 'ʲ', 'y'], [
        {keys: 'KWR', score: 1},
    ],

    // zoo, quiz, rose
    ['z', 'z'], [
        {keys: 'z', score: 1},
        {keys: 'STKPW', score: 0.84},
        {keys: 'S', score: 0.64},
        {keys: 's', score: 0.68},
    ],

    // voiced sh (zh): vision, treasure
    ['ʒ', 'zh'], [
        {keys: 'rb', score: 0.9},
    ],

    // french ê: crêpe
    ['ɛː'], [
        {keys: 'E', score: 0.87},
        {keys: 'AEU', score: 0.74},
    ],

    // spanish ñ: piñata
    ['ɲ'], [
        {keys: 'pb/KWR', score: 1},
        {keys: 'pb', score: 0.8},
        {keys: 'TPH', score: 0.8},
    ],


    // space (word separator)
    [' '], [
        {keys: '/', score: 1}, // idealy a stroke doesn't span multiple words
        {keys: '', score: 0.4}, // it's allowed to though
    ],

    // FIXME emphasis marks
    ["'"], [],
    [","], [],
    ["ˈ"], [],
    ["ˌ"], [],

]);

// left hand consonant keys are lowercase
const key_order = {
    '#': 1,
    S: 2,
    T: 3,
    K: 4,
    P: 5,
    W: 6,
    H: 7,
    R: 8,
    A: 9,
    O: 10,
    '*': 11,
    E: 12,
    U: 13,
    f: 14,
    r: 15,
    p: 16,
    b: 17,
    l: 18,
    g: 19,
    t: 20,
    s: 21,
    d: 22,
    z: 23,
};


const pronunciation_to_keys = () => simple_object_transform((word) => {
    const pronunciation = word.espeak;
    let i = 0;
    const sequences = [];
    while (i < pronunciation.length) {
        let mapping = null;
        for (let len = Math.max(longest_phoneme, pronunciation.length - i); len > 0; --len) {
            const phoneme = pronunciation.substr(i, len);
            mapping = phoneme_to_keys_map.get(phoneme);
            if (mapping) {
                i += len;
                sequences.push(mapping)
                break;
            }
        }
        if (!mapping) {
            // FIXME fix everything that errors out here
            word.espeak_fail = i;
            return word;
        }

    }
    word.key_choices = sequences;
    return word;
});


// FIXME second parameter is just for debugging
const combine_keys = (keys_choices) => {
    const expanded_length = keys_choices.reduce((a, b) => a * Math.max(1, b.length), 1);
    // current brute-force runs out of memory on long words, just give up early for now
    if (expanded_length > 1024) {
        return [];
    }
    const key_sequences = keys_choices.reduce((a, b) => {
        if (a.length === 0) {
            return [...b];
        };
        if (b.length === 0) {
            return [...a];
        }
        const ret = [];
        for (const aa of a) {
            for (const bb of b) {
                ret.push({keys: aa.keys + bb.keys, score: aa.score * bb.score});
            }
        }
        return ret;
    }, []);
    // TODO implement inversions
    // TODO implement key clusters
    // add slashes
    for (const brief of key_sequences) {
        let fixed = [];
        let score = brief.score;
        let prev_pos = 0;
        for (const key of brief.keys) {
            if (key === '/') {
                prev_pos = 0;
                score *= 0.5;
            } else {
                const pos = key_order[key];
                if (pos <= prev_pos) {
                    fixed.push('/');
                    score *= 0.5;
                    prev_pos = 0;
                }
                prev_pos = pos;
            }
            fixed.push(key);
        }
        brief.keys = fixed.join('');
        brief.score = score;
    }
    key_sequences.sort((a, b) => b.score - a.score);
    return key_sequences;
};

// use uppercase for right-hand consonants and add hyphen where needed
// input: Pr/TAp
// output: P-R/TAP
const keys_to_steno = (keys) => {
    let prev_pos = 0;
    const steno = [];
    for (const key of keys) {
        if (key === '/') {
            prev_pos = 0;
            steno.push('/');
        } else {
            const pos = key_order[key];
            if (pos > key_order.U && prev_pos < key_order.A) {
                steno.push('-');
            }
            if (pos > key_order.U) {
                steno.push(key.toUpperCase());
            } else {
                steno.push(key);
            }
            prev_pos = pos;
        }
    }
    return steno.join('');
};


const add_briefs = () => simple_object_transform((word) => {
    if (word.key_choices) {
        const key_sequences = combine_keys(word.key_choices);
        word.key_sequences = key_sequences; // FIXME delete this line
        word.briefs = key_sequences.map((key_sequence) => ({
            brief: keys_to_steno(key_sequence.keys),
            score: key_sequence.score,
        }));
        if (word.briefs.length) {
            delete word.key_sequences;
            delete word.key_choices;
        }
    }
    return word;
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

const just_best = () => simple_object_transform((chunk) => chunk.briefs && chunk.briefs.length ? {[chunk.word]: chunk.briefs[0].brief} : {[chunk.word]: null});

const parser = pipeline(
    argv.input,
    //split_lines(),
    //lines_to_json(),
    unbzip2_stream(),
    xml_to_pages(),
    extract_english_titles(),
    batch(400),
    espeak_pronunciations(),
    pronunciation_to_keys(),
    add_briefs(),
    just_best(),
    to_ndjson()
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
