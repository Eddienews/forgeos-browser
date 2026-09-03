'use strict';

const { isMediaPlaybackPage, pageProcessingPolicy } = require('../../src/engine/page-processing-policy');

module.exports = [
  {
    name: 'recognizes YouTube playback surfaces',
    gate: 'H',
    fn(a) {
      a.strictEqual(isMediaPlaybackPage('https://www.youtube.com/watch?v=abc'), true);
      a.strictEqual(isMediaPlaybackPage('https://youtube.com/shorts/abc'), true);
      a.strictEqual(isMediaPlaybackPage('https://www.youtube-nocookie.com/live/abc'), true);
      a.strictEqual(isMediaPlaybackPage('https://www.youtube.com/'), false);
      a.strictEqual(isMediaPlaybackPage('https://example.com/watch?v=abc'), false);
    },
  },
  {
    name: 'defers aggressive automatic processing only on media playback',
    gate: 'H',
    fn(a) {
      a.deepStrictEqual(pageProcessingPolicy('https://www.youtube.com/watch?v=abc'), {
        mediaPlayback: true,
        allowDomRemoval: false,
        allowAutomaticAgentView: false,
      });
      a.deepStrictEqual(pageProcessingPolicy('https://news.example/article'), {
        mediaPlayback: false,
        allowDomRemoval: true,
        allowAutomaticAgentView: true,
      });
    },
  },
];
