import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceConversation } from "../src/features/agent/voice.ts";
import { canAutoApply } from "../src/features/agent/native.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness(
  answer = async () => "这是校园资料回答。",
  { recognition = true, synthesis = true, externalSpeech } = {},
) {
  const recognizers = [],
    utterances = [],
    phases = [],
    transcripts = [],
    captions = [],
    notices = [],
    questions = [];
  let cancellations = 0;
  const environment = {
    ...(recognition
      ? {
          recognize() {
            const recognizer = {
              startCount: 0,
              abortCount: 0,
              start() {
                this.startCount++;
              },
              abort() {
                this.abortCount++;
              },
            };
            recognizers.push(recognizer);
            return recognizer;
          },
        }
      : {}),
    ...(synthesis
      ? {
          utterance(text) {
            return { text };
          },
          speak(utterance) {
            utterances.push(utterance);
          },
          cancel() {
            cancellations++;
          },
        }
      : {}),
  };
  const controller = createVoiceConversation(environment, {
    async onQuestion(question) {
      questions.push(question);
      return answer(question);
    },
    onPhase: (value) => phases.push(value),
    onTranscript: (value) => transcripts.push(value),
    onNotice: (value) => notices.push(value),
    onCaption: (value) => captions.push(value),
    ...(externalSpeech
      ? {
          speakAnswer: externalSpeech.speak,
          cancelSpeech: externalSpeech.cancel,
        }
      : {}),
  });
  const result = (text, final = true) => ({
    results: [{ isFinal: final, 0: { transcript: text } }],
  });
  return {
    controller,
    recognizers,
    utterances,
    phases,
    transcripts,
    captions,
    notices,
    questions,
    result,
    get cancellations() {
      return cancellations;
    },
  };
}

test("voice starts only explicitly; interim captions do not send and a final sends once", async () => {
  const h = harness();
  assert.equal(h.recognizers.length, 0);
  h.controller.start();
  const first = h.recognizers[0],
    listener = first.onresult;
  assert.equal(first.lang, "zh-CN");
  assert.equal(first.continuous, false);
  first.onresult(h.result("图书馆", false));
  assert.deepEqual(h.questions, []);
  assert.equal(h.transcripts.at(-1), "图书馆");
  listener(h.result("图书馆有什么楼层图？"));
  listener(h.result("图书馆有什么楼层图？"));
  await settle();
  assert.deepEqual(h.questions, ["图书馆有什么楼层图？"]);
  assert.equal(first.abortCount, 1);
  assert.equal(first.onresult, null);
  assert.equal(h.utterances.length, 1);
  assert.equal(
    h.recognizers.length,
    1,
    "microphone stays off while TTS speaks",
  );
  assert.equal(h.phases.at(-1), "speaking");
  h.utterances[0].onend();
  assert.equal(h.recognizers.length, 2, "next turn resumes only when TTS ends");
  assert.equal(h.phases.at(-1), "listening");
  h.controller.stop();
});

test("stop during model request suppresses stale speech and automatic listening", async () => {
  let finish;
  const h = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.controller.start();
  h.recognizers[0].onresult(h.result("怎么去食堂？"));
  await settle();
  h.controller.stop();
  finish("可以走这条路。");
  await settle();
  assert.equal(h.phases.at(-1), "idle");
  assert.equal(h.utterances.length, 0);
  assert.equal(h.recognizers.length, 1);
});

test("interrupt cancels speech then listens, and late TTS completion cannot start another recorder", async () => {
  const h = harness();
  h.controller.start();
  h.recognizers[0].onresult(h.result("介绍图书馆"));
  await settle();
  const oldEnd = h.utterances[0].onend;
  h.controller.interrupt();
  assert.equal(h.cancellations, 1);
  assert.equal(h.recognizers.length, 2);
  oldEnd();
  assert.equal(h.recognizers.length, 2);
  h.controller.stop();
  assert.equal(h.recognizers[1].abortCount, 1);
});

test("permission, network and no-speech errors pause without retry loops", () => {
  for (const error of ["not-allowed", "network", "no-speech"]) {
    const h = harness();
    h.controller.start();
    const oldEnd = h.recognizers[0].onend;
    h.recognizers[0].onerror({ error });
    oldEnd();
    assert.equal(h.phases.at(-1), "idle");
    assert.equal(h.recognizers.length, 1);
    assert.equal(h.questions.length, 0);
    assert.ok(h.notices.at(-1).length);
  }
});

test("recognition ending with no final result pauses rather than submitting interim text", () => {
  const h = harness();
  h.controller.start();
  h.recognizers[0].onresult(h.result("未说完的问题", false));
  h.recognizers[0].onend();
  assert.equal(h.questions.length, 0);
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.phases.at(-1), "idle");
});

test("unsupported recognizer has an explicit text fallback and never requests microphone", () => {
  const h = harness(undefined, { recognition: false });
  assert.equal(h.controller.supported, false);
  h.controller.start();
  assert.match(h.notices.at(-1), /不支持语音识别.*文字交流/);
  assert.equal(h.recognizers.length, 0);
});

test("missing synthesis uses answer captions and resumes listening without pretending to speak", async () => {
  const h = harness(undefined, { synthesis: false });
  h.controller.start();
  h.recognizers[0].onresult(h.result("帮我找图书馆"));
  await settle();
  assert.equal(h.utterances.length, 0);
  assert.match(h.notices.at(-1), /不能朗读.*字幕/);
  assert.equal(h.recognizers.length, 2);
  assert.equal(h.phases.at(-1), "listening");
  assert.equal(h.captions.at(-1), "这是校园资料回答。");
  h.controller.stop();
});

test("spoken captions follow real boundaries while the full answer is spoken unchanged", async () => {
  const answer = "图书馆有已发布的楼层图。请选择要查看的楼层。也可以继续提问。";
  const h = harness(async () => answer);
  h.controller.start();
  h.recognizers[0].onresult(h.result("介绍图书馆"));
  await settle();
  const speech = h.utterances[0];
  assert.equal(speech.text, answer);
  assert.equal(h.captions.at(-1), "图书馆有已发布的楼层图。");
  speech.onboundary({ charIndex: answer.indexOf("请选择") });
  assert.equal(h.captions.at(-1), "请选择要查看的楼层。");
  const count = h.captions.length;
  speech.onboundary({ charIndex: answer.indexOf("查看") });
  speech.onboundary({ charIndex: 0 });
  speech.onboundary({ charIndex: NaN });
  speech.onboundary({ charIndex: answer.length + 1 });
  assert.equal(
    h.captions.length,
    count,
    "unchanged, backward and invalid boundaries do not replace captions",
  );
  speech.onboundary({ charIndex: answer.indexOf("也可以") });
  assert.equal(h.captions.at(-1), "也可以继续提问。");
  speech.onend();
  assert.equal(
    h.captions.at(-1),
    "也可以继续提问。",
    "last caption remains readable while listening resumes",
  );
  assert.equal(speech.onboundary, null);
  h.controller.stop();
  assert.equal(h.captions.at(-1), "");
});

test("engines without speech boundary events retain a useful first caption without advancing on a timer", async () => {
  const h = harness(
    async () => "这是第一句。后面的完整回答仍保存在文字记录里。",
  );
  h.controller.start();
  h.recognizers[0].onresult(h.result("介绍一下"));
  await settle();
  assert.deepEqual(h.captions, ["这是第一句。"]);
  h.utterances[0].onend();
  assert.deepEqual(h.captions, ["这是第一句。"]);
  h.controller.stop();
});

test("interrupted or stopped utterance boundaries cannot overwrite the next answer caption", async () => {
  let turn = 0;
  const h = harness(async () =>
    ++turn === 1
      ? "旧回答第一句。旧回答第二句。"
      : "新回答第一句。新回答第二句。",
  );
  h.controller.start();
  h.recognizers[0].onresult(h.result("第一问"));
  await settle();
  const oldBoundary = h.utterances[0].onboundary;
  h.controller.interrupt();
  assert.equal(h.captions.at(-1), "");
  assert.equal(h.utterances[0].onboundary, null);
  assert.equal(h.cancellations, 1);
  h.recognizers[1].onresult(h.result("第二问"));
  await settle();
  oldBoundary({ charIndex: 7 });
  assert.equal(h.captions.at(-1), "新回答第一句。");
  const newBoundary = h.utterances[1].onboundary;
  h.controller.stop();
  newBoundary({ charIndex: 7 });
  assert.equal(h.captions.at(-1), "");
  assert.equal(h.cancellations, 2);
});

test("failed question pauses; stop cancels existing speech and recognizer callbacks", async () => {
  const failed = harness(async () => {
    throw new Error("failed");
  });
  failed.controller.start();
  failed.recognizers[0].onresult(failed.result("问题"));
  await settle();
  assert.equal(failed.phases.at(-1), "idle");
  assert.equal(failed.recognizers.length, 1);
  const h = harness();
  h.controller.start();
  h.recognizers[0].onresult(h.result("问题"));
  await settle();
  const oldEnd = h.utterances[0].onend;
  h.controller.stop("视频正在播放");
  oldEnd();
  assert.equal(h.cancellations, 1);
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.phases.at(-1), "idle");
});

test("all media still needs explicit server intent and unknown action types remain blocked", () => {
  for (const type of ["open_vr", "play_video", "play_audio", "future_action"])
    assert.equal(canAutoApply({ type, context_revision: 9 }, 9, 9), false);
  for (const type of [
    "show_checkin",
    "show_tour",
    "focus_point",
    "open_vr",
    "play_video",
  ])
    assert.equal(
      canAutoApply({ type, action_id: "a", context_revision: 9 }, 9, 9, "a"),
      true,
    );
  assert.equal(
    canAutoApply(
      { type: "play_audio", action_id: "a", context_revision: 9 },
      9,
      9,
      "a",
    ),
    false,
  );
  assert.equal(
    canAutoApply({ type: "show_tour", context_revision: 9 }, 9, 10),
    false,
  );
});

test("dictated replies use the injected cloud reader and await its completion before listening", async () => {
  let finish;
  const spoken = [];
  const h = harness(undefined, {
    externalSpeech: {
      speak(text, caption) {
        spoken.push(text);
        caption("真实音频对应的字幕。");
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      cancel() {},
    },
  });
  h.controller.start();
  h.recognizers[0].onresult(h.result("介绍图书馆"));
  await settle();
  assert.deepEqual(spoken, ["这是校园资料回答。"]);
  assert.equal(
    h.utterances.length,
    0,
    "never uses the old browser-only reader",
  );
  assert.equal(
    h.recognizers.length,
    1,
    "microphone stays off during cloud playback",
  );
  assert.equal(h.captions.at(-1), "真实音频对应的字幕。");
  finish(true);
  await settle();
  assert.equal(h.recognizers.length, 2);
  assert.equal(h.phases.at(-1), "listening");
  h.controller.stop();
});
test("interrupt and stop cancel the cloud reader; late captions and end cannot restart the mic", async () => {
  for (const action of ["interrupt", "stop"]) {
    let finish, caption;
    let cancelled = 0;
    const h = harness(undefined, {
      externalSpeech: {
        speak(_text, callback) {
          caption = callback;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        cancel() {
          cancelled++;
        },
      },
    });
    h.controller.start();
    h.recognizers[0].onresult(h.result("问题"));
    await settle();
    h.controller[action]();
    const before = h.recognizers.length;
    caption("迟到的旧字幕");
    finish(true);
    await settle();
    assert.equal(cancelled, 1);
    assert.equal(h.recognizers.length, before);
    assert.notEqual(h.captions.at(-1), "迟到的旧字幕");
    h.controller.stop();
  }
});
test("failure of both cloud and system speech pauses with a visible recovery notice", async () => {
  const h = harness(undefined, {
    externalSpeech: { speak: async () => false, cancel() {} },
  });
  h.controller.start();
  h.recognizers[0].onresult(h.result("问题"));
  await settle();
  assert.equal(h.recognizers.length, 1);
  assert.equal(h.phases.at(-1), "idle");
  assert.match(h.notices.at(-1), /未能播放.*播放图标/);
  h.controller.stop();
});
