/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WebMWriter.h"
#include "EncodedFrame.h"
#include "mozilla/media/MediaUtils.h"

using namespace mozilla;

extern "C" {

nsresult NS_NewWebMWriter(void** aResult) {
  auto* writer = new WebMWriter();
  *aResult = static_cast<void*>(writer);
  return NS_OK;
}

void WebMWriter_Release(void* aWriter) {
  delete static_cast<WebMWriter*>(aWriter);
}

nsresult WebMWriter_SetMetadata(void* aWriter, const void** aMetadata,
                                size_t aMetadataCount) {
  auto* writer = static_cast<WebMWriter*>(aWriter);
  nsTArray<RefPtr<TrackMetadataBase>> metadataArray;

  for (size_t i = 0; i < aMetadataCount; i++) {
    auto* metadata = static_cast<TrackMetadataBase*>(const_cast<void*>(aMetadata[i]));
    metadataArray.AppendElement(metadata);
  }

  return writer->SetMetadata(metadataArray);
}

nsresult WebMWriter_WriteEncodedTrack(void* aWriter, const void** aFrames,
                                      size_t aFrameCount, uint32_t aFlags) {
  auto* writer = static_cast<WebMWriter*>(aWriter);
  nsTArray<RefPtr<EncodedFrame>> frames;

  for (size_t i = 0; i < aFrameCount; i++) {
    auto* frame = static_cast<EncodedFrame*>(const_cast<void*>(aFrames[i]));
    frames.AppendElement(frame);
  }

  return writer->WriteEncodedTrack(frames, aFlags);
}

nsresult WebMWriter_GetContainerData(void* aWriter, void* aOutputBufs,
                                     uint32_t aFlags) {
  auto* writer = static_cast<WebMWriter*>(aWriter);
  auto* outputBufs = static_cast<nsTArray<nsTArray<uint8_t>>*>(aOutputBufs);
  return writer->GetContainerData(outputBufs, aFlags);
}

nsresult NS_NewVP8Metadata(int32_t aWidth, int32_t aHeight,
                           int32_t aDisplayWidth, int32_t aDisplayHeight,
                           void** aResult) {
  auto metadata = MakeRefPtr<VP8Metadata>();
  metadata->mWidth = aWidth;
  metadata->mHeight = aHeight;
  metadata->mDisplayWidth = aDisplayWidth;
  metadata->mDisplayHeight = aDisplayHeight;
  metadata.forget(reinterpret_cast<VP8Metadata**>(aResult));
  return NS_OK;
}

void TrackMetadataBase_AddRef(void* aMetadata) {
  static_cast<TrackMetadataBase*>(aMetadata)->AddRef();
}

void TrackMetadataBase_Release(void* aMetadata) {
  static_cast<TrackMetadataBase*>(aMetadata)->Release();
}

nsresult NS_NewEncodedFrame(int64_t aTimeUs, uint64_t aDuration,
                            uint64_t aDurationBase, uint32_t aFrameType,
                            const uint8_t* aData, size_t aDataLen,
                            void** aResult) {
  auto frameData = MakeRefPtr<media::Refcountable<nsTArray<uint8_t>>>();
  frameData->AppendElements(aData, aDataLen);

  EncodedFrame::FrameType frameType;
  if (aFrameType == 0) {
    frameType = EncodedFrame::VP8_I_FRAME;
  } else if (aFrameType == 1) {
    frameType = EncodedFrame::VP8_P_FRAME;
  } else {
    return NS_ERROR_INVALID_ARG;
  }

  media::TimeUnit time = media::TimeUnit::FromMicroseconds(aTimeUs);
  RefPtr<EncodedFrame::ConstFrameData> constFrameData = frameData;
  auto frame = MakeRefPtr<EncodedFrame>(time, aDuration, aDurationBase,
                                        frameType, constFrameData);
  frame.forget(reinterpret_cast<EncodedFrame**>(aResult));
  return NS_OK;
}

void EncodedFrame_AddRef(void* aFrame) {
  static_cast<EncodedFrame*>(aFrame)->AddRef();
}

void EncodedFrame_Release(void* aFrame) {
  static_cast<EncodedFrame*>(aFrame)->Release();
}

}  // extern "C"
