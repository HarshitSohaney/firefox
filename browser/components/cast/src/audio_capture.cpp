/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AudioCaptureTrack.h"
#include "AudioSegment.h"
#include "MediaTrackGraph.h"
#include "MediaTrackListener.h"
#include "mozilla/RefPtr.h"
#include "mozilla/dom/Document.h"
#include "nsCOMPtr.h"
#include "nsGlobalWindowInner.h"
#include "nsICastAudioCapture.h"
#include "nsICastAudioCaptureCallback.h"
#include "nsISupportsImpl.h"
#include "nsPIDOMWindow.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"
#include "nsTArray.h"
#include <cstdio>

using namespace mozilla;

namespace {

constexpr uint32_t kSampleRate = 48000;
constexpr uint32_t kChannels = 2;
constexpr uint32_t kFrameDurationMs = 20;
constexpr uint32_t kSamplesPerFrame = kSampleRate * kFrameDurationMs / 1000;

class CastAudioCaptureListener : public MediaTrackListener {
 public:
  explicit CastAudioCaptureListener(nsICastAudioCaptureCallback* aCallback,
                                    int64_t aStartTime)
      : mCallback(aCallback), mStartTime(aStartTime), mSampleCount(0) {
    printf("CastAudioCaptureListener created\n");
  }

  void NotifyQueuedChanges(MediaTrackGraph* aGraph, TrackTime aTrackOffset,
                           const MediaSegment& aQueuedMedia) override {
    mSampleCount++;
    if (mSampleCount <= 5 || mSampleCount % 100 == 0) {
      printf(
          "CastAudioCaptureListener::NotifyQueuedChanges called (count=%d, "
          "type=%d, duration=%lld)\n",
          mSampleCount, static_cast<int>(aQueuedMedia.GetType()),
          static_cast<long long>(aQueuedMedia.GetDuration()));
    }

    if (aQueuedMedia.GetType() != MediaSegment::AUDIO || !mCallback) {
      return;
    }

    const AudioSegment& audio = static_cast<const AudioSegment&>(aQueuedMedia);

    nsTArray<float> interleavedSamples;
    for (AudioSegment::ConstChunkIterator iter(audio); !iter.IsEnded();
         iter.Next()) {
      const AudioChunk& chunk = *iter;
      TrackTime frames = chunk.GetDuration();

      if (chunk.IsNull()) {
        for (TrackTime i = 0; i < frames * kChannels; i++) {
          interleavedSamples.AppendElement(0.0f);
        }
      } else {
        for (TrackTime i = 0; i < frames; i++) {
          for (uint32_t ch = 0; ch < kChannels; ch++) {
            float sample = 0.0f;
            if (ch < chunk.ChannelCount()) {
              sample = chunk.ChannelData<float>()[ch][i];
            }
            interleavedSamples.AppendElement(sample);
          }
        }
      }
    }

    if (interleavedSamples.IsEmpty()) {
      return;
    }

    int64_t timestampMs = (PR_Now() / PR_USEC_PER_MSEC) - mStartTime;
    uint32_t sampleCount =
        static_cast<uint32_t>(interleavedSamples.Length() / kChannels);

    nsTArray<uint8_t> pcmBytes;
    pcmBytes.SetLength(interleavedSamples.Length() * sizeof(float));
    memcpy(pcmBytes.Elements(), interleavedSamples.Elements(),
           pcmBytes.Length());

    nsCOMPtr<nsICastAudioCaptureCallback> callback = mCallback;
    NS_DispatchToMainThread(NS_NewRunnableFunction(
        "CastAudioCaptureListener::OnAudioSamples",
        [callback, pcmBytes = std::move(pcmBytes), timestampMs,
         sampleCount]() mutable {
          callback->OnAudioSamples(pcmBytes, timestampMs, sampleCount);
        }));
  }

 private:
  nsCOMPtr<nsICastAudioCaptureCallback> mCallback;
  int64_t mStartTime;
  int mSampleCount;
};

class CastAudioCapture final : public nsICastAudioCapture {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICASTAUDIOCAPTURE

  CastAudioCapture() = default;

 private:
  ~CastAudioCapture() { Stop(); }

  nsCOMPtr<nsPIDOMWindowInner> mWindow;
  nsCOMPtr<nsICastAudioCaptureCallback> mCallback;
  RefPtr<AudioCaptureTrack> mAudioCaptureTrack;
  RefPtr<CastAudioCaptureListener> mListener;
  bool mCapturing = false;
  int64_t mStartTime = 0;
};

NS_IMPL_ISUPPORTS(CastAudioCapture, nsICastAudioCapture)

NS_IMETHODIMP
CastAudioCapture::Init(uint64_t aWindowId) {
  printf("CastAudioCapture::Init called with windowId=%llu\n", aWindowId);

  if (!aWindowId) {
    printf("CastAudioCapture::Init: windowId is 0\n");
    return NS_ERROR_INVALID_ARG;
  }

  nsGlobalWindowInner* innerWindow =
      nsGlobalWindowInner::GetInnerWindowWithId(aWindowId);
  printf("CastAudioCapture::Init: GetInnerWindowWithId returned %p\n",
         innerWindow);

  if (!innerWindow) {
    printf("CastAudioCapture::Init: Window not found for id %llu\n", aWindowId);
    return NS_ERROR_FAILURE;
  }

  mWindow = innerWindow;
  printf("CastAudioCapture::Init: Success, mWindow set\n");
  return NS_OK;
}

NS_IMETHODIMP
CastAudioCapture::SetCallback(nsICastAudioCaptureCallback* aCallback) {
  mCallback = aCallback;
  return NS_OK;
}

NS_IMETHODIMP
CastAudioCapture::Start() {
  printf("CastAudioCapture::Start called\n");

  if (!mWindow || !mCallback) {
    printf(
        "CastAudioCapture::Start: Not initialized (window=%p, callback=%p)\n",
        mWindow.get(), mCallback.get());
    return NS_ERROR_NOT_INITIALIZED;
  }

  if (mCapturing) {
    printf("CastAudioCapture::Start: Already capturing\n");
    return NS_OK;
  }

  printf("CastAudioCapture::Start: Getting MediaTrackGraph for window %llu\n",
         mWindow->WindowID());

  MediaTrackGraph* mtg = MediaTrackGraph::GetInstance(
      MediaTrackGraph::AUDIO_THREAD_DRIVER, mWindow,
      MediaTrackGraph::REQUEST_DEFAULT_SAMPLE_RATE,
      MediaTrackGraph::DEFAULT_OUTPUT_DEVICE);
  if (!mtg) {
    printf("CastAudioCapture::Start: Failed to get MediaTrackGraph\n");
    return NS_ERROR_FAILURE;
  }

  printf("CastAudioCapture::Start: Creating AudioCaptureTrack\n");
  mAudioCaptureTrack = mtg->CreateAudioCaptureTrack();
  if (!mAudioCaptureTrack) {
    printf("CastAudioCapture::Start: Failed to create AudioCaptureTrack\n");
    return NS_ERROR_FAILURE;
  }

  mStartTime = PR_Now() / PR_USEC_PER_MSEC;
  mListener = new CastAudioCaptureListener(mCallback, mStartTime);

  printf("CastAudioCapture::Start: Registering capture track for window %llu\n",
         mWindow->WindowID());
  mAudioCaptureTrack->AddListener(mListener);
  mAudioCaptureTrack->Graph()->RegisterCaptureTrackForWindow(
      mWindow->WindowID(), mAudioCaptureTrack);
  mWindow->SetAudioCapture(true);
  mAudioCaptureTrack->Start();

  mCapturing = true;
  printf("CastAudioCapture::Start: Success, capturing started\n");
  return NS_OK;
}

NS_IMETHODIMP
CastAudioCapture::Stop() {
  if (!mCapturing) {
    return NS_OK;
  }

  if (mAudioCaptureTrack) {
    if (mListener) {
      mAudioCaptureTrack->RemoveListener(mListener);
      mListener = nullptr;
    }

    if (mWindow && !mAudioCaptureTrack->IsDestroyed()) {
      mWindow->SetAudioCapture(false);
      mAudioCaptureTrack->Graph()->UnregisterCaptureTrackForWindow(
          mWindow->WindowID());
    }

    mAudioCaptureTrack->Destroy();
    mAudioCaptureTrack = nullptr;
  }

  mCapturing = false;
  return NS_OK;
}

NS_IMETHODIMP
CastAudioCapture::GetCapturing(bool* aCapturing) {
  *aCapturing = mCapturing;
  return NS_OK;
}

NS_IMETHODIMP
CastAudioCapture::GetSampleRate(uint32_t* aSampleRate) {
  *aSampleRate = kSampleRate;
  return NS_OK;
}

NS_IMETHODIMP
CastAudioCapture::GetChannels(uint32_t* aChannels) {
  *aChannels = kChannels;
  return NS_OK;
}

}  // namespace

extern "C" {

nsresult NS_NewCastAudioCapture(const nsIID& aIID, void** aResult) {
  RefPtr<CastAudioCapture> capture = new CastAudioCapture();
  return capture->QueryInterface(aIID, aResult);
}

}  // extern "C"
