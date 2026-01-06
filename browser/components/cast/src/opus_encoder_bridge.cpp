/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <opus/opus.h>
#include <speex/speex_resampler.h>

#include "nsError.h"
#include "nsTArray.h"

namespace {
constexpr int kOpusSamplingRate = 48000;
constexpr int kOpusFrameDurationMs = 20;
constexpr int kMaxDataBytes = 4096;
}  // namespace

extern "C" {

struct CastOpusEncoder {
  OpusEncoder* mEncoder;
  SpeexResamplerState* mResampler;
  uint32_t mInputSampleRate;
  uint32_t mChannels;
  int mLookahead;
  nsTArray<float> mBuffer;
};

nsresult CastOpusEncoder_Create(uint32_t aSampleRate, uint32_t aChannels,
                                uint32_t aBitrate, void** aResult) {
  if (aChannels == 0 || aChannels > 2) {
    return NS_ERROR_INVALID_ARG;
  }

  auto* encoder = new CastOpusEncoder();
  encoder->mInputSampleRate = aSampleRate;
  encoder->mChannels = aChannels;
  encoder->mResampler = nullptr;

  int error = 0;
  encoder->mEncoder = opus_encoder_create(kOpusSamplingRate, aChannels,
                                          OPUS_APPLICATION_AUDIO, &error);
  if (error != OPUS_OK || !encoder->mEncoder) {
    delete encoder;
    return NS_ERROR_FAILURE;
  }

  if (aBitrate > 0) {
    opus_encoder_ctl(encoder->mEncoder,
                     OPUS_SET_BITRATE(static_cast<int>(aBitrate)));
  }

  opus_encoder_ctl(encoder->mEncoder, OPUS_GET_LOOKAHEAD(&encoder->mLookahead));

  if (aSampleRate != kOpusSamplingRate) {
    encoder->mResampler =
        speex_resampler_init(aChannels, aSampleRate, kOpusSamplingRate,
                             SPEEX_RESAMPLER_QUALITY_DEFAULT, &error);
    if (error != RESAMPLER_ERR_SUCCESS) {
      opus_encoder_destroy(encoder->mEncoder);
      delete encoder;
      return NS_ERROR_FAILURE;
    }
  }

  *aResult = encoder;
  return NS_OK;
}

void CastOpusEncoder_Destroy(void* aEncoder) {
  auto* encoder = static_cast<CastOpusEncoder*>(aEncoder);
  if (encoder) {
    if (encoder->mEncoder) {
      opus_encoder_destroy(encoder->mEncoder);
    }
    if (encoder->mResampler) {
      speex_resampler_destroy(encoder->mResampler);
    }
    delete encoder;
  }
}

uint32_t CastOpusEncoder_GetLookahead(void* aEncoder) {
  auto* encoder = static_cast<CastOpusEncoder*>(aEncoder);
  return encoder ? static_cast<uint32_t>(encoder->mLookahead) : 0;
}

uint32_t CastOpusEncoder_GetChannels(void* aEncoder) {
  auto* encoder = static_cast<CastOpusEncoder*>(aEncoder);
  return encoder ? encoder->mChannels : 0;
}

uint32_t CastOpusEncoder_GetSampleRate(void* /* aEncoder */) {
  return kOpusSamplingRate;
}

int CastOpusEncoder_GetFrameSize(void* aEncoder) {
  auto* encoder = static_cast<CastOpusEncoder*>(aEncoder);
  if (!encoder) {
    return 0;
  }
  return kOpusSamplingRate * kOpusFrameDurationMs / 1000;
}

nsresult CastOpusEncoder_Encode(void* aEncoder, const float* aPcmData,
                                size_t aSampleCount, uint8_t* aOutput,
                                size_t aOutputCapacity, size_t* aOutputLen) {
  auto* encoder = static_cast<CastOpusEncoder*>(aEncoder);
  if (!encoder || !encoder->mEncoder) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  *aOutputLen = 0;

  encoder->mBuffer.AppendElements(aPcmData, aSampleCount);

  int frameSize = CastOpusEncoder_GetFrameSize(encoder);
  size_t samplesNeeded = static_cast<size_t>(frameSize * encoder->mChannels);

  nsTArray<float> resampledBuffer;
  float* inputBuffer = encoder->mBuffer.Elements();
  size_t inputSamples = encoder->mBuffer.Length();

  if (encoder->mResampler) {
    uint32_t inFrames =
        static_cast<uint32_t>(inputSamples / encoder->mChannels);
    uint32_t outFrames =
        (inFrames * kOpusSamplingRate / encoder->mInputSampleRate) + 1;
    resampledBuffer.SetLength(outFrames * encoder->mChannels);

    speex_resampler_process_interleaved_float(
        encoder->mResampler, encoder->mBuffer.Elements(), &inFrames,
        resampledBuffer.Elements(), &outFrames);

    inputBuffer = resampledBuffer.Elements();
    inputSamples = outFrames * encoder->mChannels;
    encoder->mBuffer.Clear();
  }

  if (inputSamples < samplesNeeded) {
    if (!encoder->mResampler) {
      return NS_OK;
    }
    encoder->mBuffer.AppendElements(inputBuffer, inputSamples);
    return NS_OK;
  }

  int result = opus_encode_float(encoder->mEncoder, inputBuffer, frameSize,
                                 aOutput, static_cast<int>(aOutputCapacity));
  if (result < 0) {
    return NS_ERROR_FAILURE;
  }

  *aOutputLen = static_cast<size_t>(result);

  size_t consumedSamples = samplesNeeded;
  if (inputSamples > consumedSamples) {
    if (encoder->mResampler) {
      // inputBuffer points to resampledBuffer (local), safe to clear mBuffer
      // first
      encoder->mBuffer.Clear();
      encoder->mBuffer.AppendElements(inputBuffer + consumedSamples,
                                      inputSamples - consumedSamples);
    } else {
      // inputBuffer points to mBuffer.Elements(), use RemoveElementsAt to avoid
      // invalidating the pointer
      encoder->mBuffer.RemoveElementsAt(0, consumedSamples);
    }
  } else if (!encoder->mResampler) {
    encoder->mBuffer.RemoveElementsAt(0, consumedSamples);
  }

  return NS_OK;
}

nsresult CastOpusEncoder_Flush(void* aEncoder, uint8_t* aOutput,
                               size_t aOutputCapacity, size_t* aOutputLen) {
  auto* encoder = static_cast<CastOpusEncoder*>(aEncoder);
  if (!encoder || !encoder->mEncoder) {
    *aOutputLen = 0;
    return NS_OK;
  }

  int frameSize = CastOpusEncoder_GetFrameSize(encoder);
  size_t samplesNeeded = static_cast<size_t>(frameSize * encoder->mChannels);

  if (encoder->mBuffer.Length() < samplesNeeded) {
    size_t padSize = samplesNeeded - encoder->mBuffer.Length();
    for (size_t i = 0; i < padSize; i++) {
      encoder->mBuffer.AppendElement(0.0f);
    }
  }

  int result =
      opus_encode_float(encoder->mEncoder, encoder->mBuffer.Elements(),
                        frameSize, aOutput, static_cast<int>(aOutputCapacity));
  encoder->mBuffer.Clear();

  if (result < 0) {
    *aOutputLen = 0;
    return NS_ERROR_FAILURE;
  }

  *aOutputLen = static_cast<size_t>(result);
  return NS_OK;
}

}  // extern "C"
