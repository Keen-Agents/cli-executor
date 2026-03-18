# AI Photo Enhancement Portfolio (iOS-First) вЂ” Production-Ready Implementation Plan

> **Scope clarification:** The ticket title mentions "Photo/Video Enhancement Portfolio." This plan **explicitly scopes to photo-only** for the initial release. Video enhancement (video picker, transcoding, upload, preview, export, video-capable AI models) is deferred to a future phase. The rationale: video processing requires fundamentally different infrastructure (large file streaming, longer processing times, different AI models, video player UI), and shipping 3 polished photo apps first establishes the portfolio with lower risk. A follow-up ticket should be created for the video enhancement phase.

## 1. Analysis

### What This Ticket Requires (Photo Scope)
Build 3 standalone Flutter iOS apps sharing a common core library, backed by a lightweight backend/BFF that owns all vendor API secrets:

1. **AI Background Remover** вЂ” One-tap background removal via Stability AI, plus on-device compositing for background replacement (solid colors, gradients, bundled images, custom photo)
2. **AI Photo Enhancer** вЂ” Upscale (2Г—/4Г—), denoise, sharpen, and auto-enhance via Replicate, with per-mode model selection
3. **AI Old Photo Restorer** вЂ” Face restoration (GFPGAN/CodeFormer), scratch/damage repair (Bringing-Old-Photos-Back-to-Life), and optional colorization (DeOldify) via Replicate

All 3 apps share: RevenueCat subscriptions, Firebase Analytics, image picker/cropper, before/after UI, export/share, onboarding paywall вЂ” but each app **owns its own screens, providers, and routing**.

### Key Technical Challenges
1. **Backend/BFF for secret management** вЂ” Vendor API keys (Stability AI, Replicate) must never ship in the client. A backend proxy owns secrets, enforces per-user quotas, persists job state, receives webhooks, and stores output assets.
2. **Persistent async job lifecycle** вЂ” AI jobs can take 5вЂ“60s. The app may be backgrounded, suspended, or killed. Jobs must be persisted locally and on the backend, with reattachment on relaunch and push/local notification on completion.
3. **Large image handling without OOM** вЂ” Photos can be 20MB+ / 48MP. All API contracts must use file paths (not `Uint8List`), compress/resize before upload, stream downloads, and isolate CPU-heavy work.
4. **Subscription gating** вЂ” RevenueCat integration with free trial tracking, paywall enforcement, and restore purchases вЂ” must be bulletproof for App Store review.
5. **Idempotent, safe retries** вЂ” Billable POST endpoints (create prediction, upload image) must not be blindly retried. Use client-generated idempotency keys and per-endpoint retry policies.
6. **App Store compliance** вЂ” Each app needs unique value proposition, privacy manifests, subscription disclosure, and photo permission justification.

### AI Model Matrix

| App | Feature | Model / Endpoint | Version | Max Input | Output Format | Fallback |
|-----|---------|-----------------|---------|-----------|---------------|----------|
| BG Remover | Remove background | Stability AI `/v2beta/stable-image/edit/remove-background` | v2beta | 10MP, 20MB, PNG/JPEG/WebP | PNG (RGBA) | Return error with retry prompt |
| BG Remover | Replace background | **On-device compositing** (Flutter Canvas) | N/A | Output from removal | PNG/JPEG | N/A (local) |
| Enhancer | Upscale 2Г—/4Г— | `nightmareai/real-esrgan:f121d640вЂ¦` | Pinned hash | 4MP (larger auto-downscaled), JPEG/PNG | PNG | `xinntao/realesrgan` as secondary |
| Enhancer | Denoise | `nightmareai/real-esrgan` with denoise_strength param | Pinned hash | 4MP | PNG | Same model, lower strength |
| Enhancer | Sharpen | `nightmareai/real-esrgan` with sharpen param | Pinned hash | 4MP | PNG | Unsharp-mask on-device fallback |
| Enhancer | Auto | Upscale + denoise combined | Pinned hash | 4MP | PNG | Individual steps sequentially |
| Restorer | Face restoration | `tencentarc/gfpgan:9283608cвЂ¦` | Pinned hash | 4MP, JPEG/PNG | PNG | `sczhou/codeformer` as secondary |
| Restorer | Scratch repair | `microsoft/bringing-old-photos-back-to-life:c75db81dвЂ¦` | Pinned hash | 4MP | PNG | GFPGAN alone (graceful degrade) |
| Restorer | Colorize | `arielreplicate/deoldify_image:0da600fвЂ¦` | Pinned hash | 4MP | PNG | Skip step, return B&W restored |

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Backend/BFF** | Node.js (Express/Fastify) or Cloud Functions, deployed to Firebase/Cloud Run |
| **Backend DB** | Firestore (job records, user quotas) |
| **Backend Storage** | Cloud Storage (GCS) with signed URLs for uploads/downloads |
| Framework | Flutter 3.x (iOS-first) |
| AI - Background | Stability AI API (via backend proxy) |
| AI - Enhance/Restore | Replicate API (via backend proxy with webhook completion) |
| Subscriptions | RevenueCat Flutter SDK (public SDK key only in-app) |
| Analytics | Firebase Analytics + Crashlytics |
| State Management | Riverpod 2.x (app-level only; core package is pure Dart) |
| HTTP (client) | Dio with interceptors (talks to BFF, not vendor APIs) |
| Local DB | Drift (SQLite) for job persistence + history metadata |
| Image Processing | image_picker, image_cropper, flutter_image_compress |
| File Storage | path_provider (temp + app documents directories) |
| UI | Material 3 + custom per-app theme |

---

## 2. Affected Files вЂ” Complete Directory Structure

```
ai_photo_portfolio/
в”њв”Ђв”Ђ melos.yaml                              # Monorepo orchestration
в”њв”Ђв”Ђ pubspec.yaml                            # Root workspace pubspec
в”њв”Ђв”Ђ analysis_options.yaml                   # Shared lint rules
в”њв”Ђв”Ђ .github/
в”‚   в””в”Ђв”Ђ workflows/
в”‚       в”њв”Ђв”Ђ ci.yml                          # CI: lint + test all packages/apps
в”‚       в”њв”Ђв”Ђ backend_deploy.yml              # Deploy backend to Cloud Run
в”‚       в””в”Ђв”Ђ deploy_ios.yml                  # Fastlane iOS deployment per app
в”‚
в”њв”Ђв”Ђ backend/                                # BFF / API proxy server
в”‚   в”њв”Ђв”Ђ package.json
в”‚   в”њв”Ђв”Ђ tsconfig.json
в”‚   в”њв”Ђв”Ђ .env.example                        # STABILITY_API_KEY, REPLICATE_API_TOKEN, GCS_BUCKET, etc.
в”‚   в”њв”Ђв”Ђ src/
в”‚   в”‚   в”њв”Ђв”Ђ index.ts                        # Server entry point
в”‚   в”‚   в”њв”Ђв”Ђ config.ts                       # Env var loading + validation
в”‚   в”‚   в”њв”Ђв”Ђ middleware/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ auth.ts                     # Firebase Auth token verification
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ rate_limit.ts               # Per-user rate limiting
в”‚   в”‚   в”‚   в””в”Ђв”Ђ quota.ts                    # Per-user daily/monthly job quota enforcement
в”‚   в”‚   в”њв”Ђв”Ђ routes/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ jobs.ts                     # POST /jobs (create), GET /jobs/:id (status), GET /jobs (list)
в”‚   в”‚   в”‚   в””в”Ђв”Ђ health.ts                   # Health check
в”‚   в”‚   в”њв”Ђв”Ђ services/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ stability_ai.ts             # Stability AI remove-bg proxy
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ replicate.ts                # Replicate prediction create + sync-first logic
в”‚   в”‚   в”‚   в””в”Ђв”Ђ storage.ts                  # GCS upload signed URLs, download signed URLs, output persistence
в”‚   в”‚   в”њв”Ђв”Ђ webhooks/
в”‚   в”‚   в”‚   в””в”Ђв”Ђ replicate_webhook.ts        # POST /webhooks/replicate вЂ” receives completion, persists output, updates job
в”‚   в”‚   в”њв”Ђв”Ђ models/
в”‚   в”‚   в”‚   в””в”Ђв”Ђ job.ts                      # Job record: id, userId, appId, modelId, status, inputUrl, outputUrl, idempotencyKey, timestamps
в”‚   в”‚   в””в”Ђв”Ђ lib/
в”‚   в”‚       в”њв”Ђв”Ђ idempotency.ts              # Idempotency key check/store
в”‚   в”‚       в””в”Ђв”Ђ notifications.ts            # FCM push for job completion
в”‚   в””в”Ђв”Ђ test/
в”‚       в”њв”Ђв”Ђ routes/
в”‚       в”‚   в””в”Ђв”Ђ jobs.test.ts
в”‚       в”њв”Ђв”Ђ services/
в”‚       в”‚   в”њв”Ђв”Ђ stability_ai.test.ts
в”‚       в”‚   в””в”Ђв”Ђ replicate.test.ts
в”‚       в””в”Ђв”Ђ webhooks/
в”‚           в””в”Ђв”Ђ replicate_webhook.test.ts
в”‚
в”њв”Ђв”Ђ packages/
в”‚   в”њв”Ђв”Ђ core/                               # Shared domain + network (pure Dart, no Flutter/Riverpod)
в”‚   в”‚   в”њв”Ђв”Ђ pubspec.yaml
в”‚   в”‚   в”њв”Ђв”Ђ lib/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ core.dart                   # Barrel export
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ api/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ bff_client.dart               # Dio client в†’ BFF endpoints (NOT vendor APIs)
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ api_exceptions.dart           # Typed: RateLimitException, TimeoutException, AuthException, QuotaExceededException
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ interceptors/
в”‚   в”‚   в”‚   в”‚       в”њв”Ђв”Ђ auth_interceptor.dart     # Inject Firebase Auth ID token
в”‚   в”‚   в”‚   в”‚       в”њв”Ђв”Ђ logging_interceptor.dart  # Request/response logging
в”‚   в”‚   в”‚   в”‚       в””в”Ђв”Ђ retry_interceptor.dart    # Retry GET/poll only; never retry POST without idempotency key
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ models/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ processing_job.dart           # Job: id, status(pending/uploading/processing/completed/failed), modelId, inputPath, outputPath, idempotencyKey, createdAt, updatedAt
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ processing_result.dart        # Result with output file path (not bytes) + metadata
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ subscription_status.dart      # Subscription state model
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ services/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ image_service.dart            # Pick, compress (max 4MP/10MB), validate format, save to temp вЂ” all file-path-based
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ subscription_service.dart     # RevenueCat wrapper (public SDK key only)
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ analytics_service.dart        # Firebase analytics wrapper
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ job_service.dart              # Create job в†’ BFF, poll/reattach, persist locally, handle completion
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ job_persistence.dart          # Drift (SQLite) DAO: save/load/update local job records
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ db/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ app_database.dart             # Drift database definition
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ tables/
в”‚   в”‚   в”‚   в”‚       в”њв”Ђв”Ђ jobs_table.dart           # Local job persistence table
в”‚   в”‚   в”‚   в”‚       в””в”Ђв”Ђ history_table.dart        # Completed job history with metadata
в”‚   в”‚   в”‚   в””в”Ђв”Ђ config/
в”‚   в”‚   в”‚       в”њв”Ђв”Ђ bff_config.dart               # BFF base URL (per environment)
в”‚   в”‚   в”‚       в”њв”Ђв”Ђ image_constraints.dart        # Max pixel count, file size, allowed formats, export sizes
в”‚   в”‚   в”‚       в””в”Ђв”Ђ subscription_config.dart      # RevenueCat public SDK key, product IDs, offering IDs
в”‚   в”‚   в””в”Ђв”Ђ test/
в”‚   в”‚       в”њв”Ђв”Ђ api/
в”‚   в”‚       в”‚   в””в”Ђв”Ђ bff_client_test.dart
в”‚   в”‚       в”њв”Ђв”Ђ services/
в”‚   в”‚       в”‚   в”њв”Ђв”Ђ job_service_test.dart
в”‚   в”‚       в”‚   в”њв”Ђв”Ђ job_persistence_test.dart
в”‚   в”‚       в”‚   в”њв”Ђв”Ђ subscription_service_test.dart
в”‚   в”‚       в”‚   в””в”Ђв”Ђ image_service_test.dart
в”‚   в”‚       в””в”Ђв”Ђ db/
в”‚   в”‚           в””в”Ђв”Ђ app_database_test.dart
в”‚   в”‚
в”‚   в””в”Ђв”Ђ shared_ui/                          # Shared UI **components only** (no screens)
в”‚       в”њв”Ђв”Ђ pubspec.yaml
в”‚       в”њв”Ђв”Ђ lib/
в”‚       в”‚   в”њв”Ђв”Ђ shared_ui.dart              # Barrel export
в”‚       в”‚   в”њв”Ђв”Ђ theme/
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ app_theme.dart                # Base Material 3 theme (apps can override)
в”‚       в”‚   в”‚   в””в”Ђв”Ђ app_colors.dart               # Shared color tokens
в”‚       в”‚   в””в”Ђв”Ђ widgets/
в”‚       в”‚       в”њв”Ђв”Ђ before_after_slider.dart       # Before/after comparison (file-path-based, decoded to display size)
в”‚       в”‚       в”њв”Ђв”Ђ processing_overlay.dart        # Loading animation with progress/status text
в”‚       в”‚       в”њв”Ђв”Ђ paywall_sheet.dart             # Bottom sheet paywall (configurable products)
в”‚       в”‚       в”њв”Ђв”Ђ onboarding_page.dart           # Reusable onboarding page template
в”‚       в”‚       в”њв”Ђв”Ђ image_picker_sheet.dart        # Camera/gallery picker
в”‚       в”‚       в”њв”Ђв”Ђ export_share_sheet.dart        # Save to library / share result
в”‚       в”‚       в”њв”Ђв”Ђ error_dialog.dart              # Styled error dialog
в”‚       в”‚       в”њв”Ђв”Ђ subscription_badge.dart        # Pro badge widget
в”‚       в”‚       в””в”Ђв”Ђ subscription_disclosure.dart   # App Store required subscription terms
в”‚       в””в”Ђв”Ђ test/
в”‚           в””в”Ђв”Ђ widgets/
в”‚               в”њв”Ђв”Ђ before_after_slider_test.dart
в”‚               в””в”Ђв”Ђ paywall_sheet_test.dart
в”‚
в”њв”Ђв”Ђ apps/
в”‚   в”њв”Ђв”Ђ bg_remover/                         # App 1: AI Background Remover
в”‚   в”‚   в”њв”Ђв”Ђ pubspec.yaml
в”‚   в”‚   в”њв”Ђв”Ђ ios/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ Runner.xcodeproj/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ Runner/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ Info.plist                    # NSPhotoLibraryUsageDescription, NSCameraUsageDescription
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ PrivacyInfo.xcprivacy         # iOS 17+ privacy manifest
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ Assets.xcassets/
в”‚   в”‚   в”‚   в””в”Ђв”Ђ Podfile
в”‚   в”‚   в”њв”Ђв”Ђ lib/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ main.dart                         # App entry, ProviderScope, Firebase init
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ app.dart                          # MaterialApp, GoRouter, app-specific theme
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ screens/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ onboarding_screen.dart        # App-specific onboarding (uses shared_ui widgets)
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ home_screen.dart              # Pick photo CTA
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ editor_screen.dart            # Removal result + background replacement compositor
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ backgrounds_screen.dart       # Background template gallery
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ settings_screen.dart          # App-specific settings (uses shared_ui widgets)
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ providers/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ bg_removal_provider.dart      # Job lifecycle: create в†’ track в†’ complete
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ compositor_provider.dart      # On-device background compositing state
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ background_templates_provider.dart
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ services/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ bg_removal_service.dart       # Orchestrates: compress в†’ upload via BFF в†’ track job в†’ download result
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ compositor_service.dart       # On-device compositing: overlay foreground on chosen background
в”‚   в”‚   в”‚   в””в”Ђв”Ђ widgets/
в”‚   в”‚   в”‚       в”њв”Ђв”Ђ background_grid.dart
в”‚   в”‚   в”‚       в”њв”Ђв”Ђ result_preview.dart           # Renders PNG with transparency on checkerboard
в”‚   в”‚   в”‚       в””в”Ђв”Ђ color_picker_button.dart      # Solid color background picker
в”‚   в”‚   в”њв”Ђв”Ђ assets/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ backgrounds/                      # 20 built-in background images (optimized, <200KB each)
в”‚   в”‚   в”‚   в””в”Ђв”Ђ onboarding/
в”‚   в”‚   в””в”Ђв”Ђ test/
в”‚   в”‚       в”њв”Ђв”Ђ screens/
в”‚   в”‚       в”‚   в””в”Ђв”Ђ home_screen_test.dart
в”‚   в”‚       в”њв”Ђв”Ђ services/
в”‚   в”‚       в”‚   в”њв”Ђв”Ђ bg_removal_service_test.dart
в”‚   в”‚       в”‚   в””в”Ђв”Ђ compositor_service_test.dart
в”‚   в”‚       в””в”Ђв”Ђ providers/
в”‚   в”‚           в””в”Ђв”Ђ bg_removal_provider_test.dart
в”‚   в”‚
в”‚   в”њв”Ђв”Ђ photo_enhancer/                     # App 2: AI Photo Enhancer
в”‚   в”‚   в”њв”Ђв”Ђ pubspec.yaml
в”‚   в”‚   в”њв”Ђв”Ђ ios/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ Runner.xcodeproj/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ Runner/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ Info.plist
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ PrivacyInfo.xcprivacy
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ Assets.xcassets/
в”‚   в”‚   в”‚   в””в”Ђв”Ђ Podfile
в”‚   в”‚   в”њв”Ђв”Ђ lib/
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ main.dart
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ app.dart
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ screens/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ onboarding_screen.dart
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ home_screen.dart              # Pick photo + enhancement mode selector
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ enhance_screen.dart           # Processing + before/after result
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ history_screen.dart           # Enhancement history (from Drift DB)
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ settings_screen.dart
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ providers/
в”‚   в”‚   в”‚   в”‚   в”њв”Ђв”Ђ enhance_provider.dart         # Job lifecycle per enhancement mode
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ history_provider.dart         # Reads from local Drift history table
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ services/
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ enhance_service.dart          # Maps mode в†’ model, orchestrates BFF job
в”‚   в”‚   в”‚   в”њв”Ђв”Ђ models/
в”‚   в”‚   в”‚   в”‚   в””в”Ђв”Ђ enhance_mode.dart             # Enum: upscale2x, upscale4x, denoise, sharpen, auto вЂ” each maps to model + params
в”‚   в”‚   в”‚   в””в”Ђв”Ђ widgets/
в”‚   в”‚   в”‚       в”њв”Ђв”Ђ mode_selector.dart
в”‚   в”‚   в”‚       в””в”Ђв”Ђ intensity_slider.dart
в”‚   в”‚   в”њв”Ђв”Ђ assets/
в”‚   в”‚   в”‚   в””в”Ђв”Ђ onboarding/
в”‚   в”‚   в””в”Ђв”Ђ test/
в”‚   в”‚       в”њв”Ђв”Ђ services/
в”‚   в”‚       в”‚   в””в”Ђв”Ђ enhance_service_test.dart
в”‚   в”‚       в””в”Ђв”Ђ providers/
в”‚   в”‚           в””в”Ђв”Ђ enhance_provider_test.dart
в”‚   в”‚
в”‚   в””в”Ђв”Ђ photo_restorer/                     # App 3: AI Old Photo Restorer
в”‚       в”њв”Ђв”Ђ pubspec.yaml
в”‚       в”њв”Ђв”Ђ ios/
в”‚       в”‚   в”њв”Ђв”Ђ Runner.xcodeproj/
в”‚       в”‚   в”њв”Ђв”Ђ Runner/
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ Info.plist
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ PrivacyInfo.xcprivacy
в”‚       в”‚   в”‚   в””в”Ђв”Ђ Assets.xcassets/
в”‚       в”‚   в””в”Ђв”Ђ Podfile
в”‚       в”њв”Ђв”Ђ lib/
в”‚       в”‚   в”њв”Ђв”Ђ main.dart
в”‚       в”‚   в”њв”Ђв”Ђ app.dart
в”‚       в”‚   в”њв”Ђв”Ђ screens/
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ onboarding_screen.dart
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ home_screen.dart              # Pick photo + scan option
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ restore_screen.dart           # Multi-step: scratch repair в†’ face restore в†’ optional colorize
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ colorize_screen.dart          # Optional colorization result
в”‚       в”‚   в”‚   в””в”Ђв”Ђ settings_screen.dart
в”‚       в”‚   в”њв”Ђв”Ђ providers/
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ restore_provider.dart         # Multi-step job pipeline state
в”‚       в”‚   в”‚   в””в”Ђв”Ђ colorize_provider.dart
в”‚       в”‚   в”њв”Ђв”Ђ services/
в”‚       в”‚   в”‚   в”њв”Ђв”Ђ restore_service.dart          # Pipeline: scratch repair в†’ face restore, each as separate BFF job
в”‚       в”‚   в”‚   в””в”Ђв”Ђ colorize_service.dart         # BFF job for DeOldify
в”‚       в”‚   в””в”Ђв”Ђ widgets/
в”‚       в”‚       в”њв”Ђв”Ђ damage_indicator.dart
в”‚       в”‚       в”њв”Ђв”Ђ face_toggle.dart
в”‚       в”‚       в””в”Ђв”Ђ pipeline_progress.dart        # Multi-step progress indicator
в”‚       в”њв”Ђв”Ђ assets/
в”‚       в”‚   в””в”Ђв”Ђ onboarding/
в”‚       в””в”Ђв”Ђ test/
в”‚           в”њв”Ђв”Ђ services/
в”‚           в”‚   в””в”Ђв”Ђ restore_service_test.dart
в”‚           в””в”Ђв”Ђ providers/
в”‚               в””в”Ђв”Ђ restore_provider_test.dart
```

**Total: ~120 files** (including backend, pubspecs, configs, tests).

---

## 3. Implementation Steps (Max 2-Hour Tasks)

### Phase 0: Monorepo + Project Setup (Day 1)

| # | Task | Time | Description |
|---|------|------|-------------|
| 1 | Initialize monorepo with Melos | 1h | Create workspace, configure `melos.yaml` with `apps/*` and `packages/*` globs, set up `analysis_options.yaml` with `flutter_lints`, add root `.gitignore` |
| 2 | Create `packages/core` scaffold | 1h | `pubspec.yaml` with deps (dio, drift, purchases_flutter, firebase_analytics, firebase_auth, uuid), barrel exports, folder structure. **No vendor API keys in this package.** |
| 3 | Create `packages/shared_ui` scaffold | 1h | `pubspec.yaml` with flutter dep, barrel exports. **Widgets only, no screens.** |
| 4 | Create 3 app shells | 2h | `flutter create` for bg_remover, photo_enhancer, photo_restorer. Wire dependency on core + shared_ui. Verify `melos bootstrap` succeeds. Each app gets its own `screens/`, `providers/`, `services/` |
| 5 | Configure iOS project settings | 2h | Per app: bundle IDs, display names, iOS 16.0 minimum, `NSPhotoLibraryUsageDescription`, `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription` in Info.plist. Create `PrivacyInfo.xcprivacy` per app with required privacy manifest entries for network, photo library, and analytics |
| 6 | Set up environment + BFF config | 1h | Create `bff_config.dart` with BFF base URL per environment (dev/staging/prod via `--dart-define`). Create `image_constraints.dart` with max pixel count (4MP for Replicate, 10MP for Stability), max file size (20MB raw, 10MB upload), allowed formats. Create `subscription_config.dart` with RevenueCat **public SDK key** only. Add `.env.example` for backend secrets. **No vendor API keys in Flutter.** |

### Phase 1: Backend / BFF (Days 2вЂ“4)

| # | Task | Time | Description |
|---|------|------|-------------|
| 7 | Initialize backend project | 1h | Node.js + TypeScript + Express/Fastify. `package.json`, `tsconfig.json`, folder structure. Add Firebase Admin SDK, `@google-cloud/storage`, `replicate` npm package |
| 8 | Implement Firebase Auth middleware | 1.5h | `auth.ts`: verify Firebase ID token from `Authorization: Bearer <token>` header. Extract userId. Reject unauthenticated requests. |
| 9 | Implement rate limiting + quota middleware | 1.5h | `rate_limit.ts`: per-userId sliding window (e.g., 10 req/min). `quota.ts`: read user's daily/monthly job count from Firestore, enforce free-tier (3/day) vs paid-tier (unlimited) limits. Integrate with RevenueCat server-side webhook or API for subscription verification |
| 10 | Implement idempotency layer | 1h | `idempotency.ts`: client sends `Idempotency-Key` header (UUID). Store key в†’ job mapping in Firestore with 24h TTL. If key exists, return existing job instead of creating new one |
| 11 | Implement GCS storage service | 1.5h | `storage.ts`: generate signed upload URLs (PUT, 15min TTL, max 10MB), generate signed download URLs (GET, 1h TTL). Organize by `userId/jobId/input.*` and `userId/jobId/output.*`. Auto-delete after 30 days (lifecycle policy) |
| 12 | Implement Stability AI proxy service | 1.5h | `stability_ai.ts`: download input from GCS, POST to Stability AI remove-background endpoint with multipart form data, upload output PNG to GCS, return output URL. Handle API errors with structured responses |
| 13 | Implement Replicate proxy service | 2h | `replicate.ts`: create prediction with `sync` mode first (Replicate returns result directly for fast models). If model doesn't support sync or times out at 60s, fall back to async with webhook URL. Map model aliases (`upscale-2x`, `face-restore`, etc.) to pinned model versions from the model matrix. Validate input dimensions/format before calling API |
| 14 | Implement Replicate webhook handler | 1.5h | `replicate_webhook.ts`: POST endpoint, verify webhook signature, download output from Replicate URL в†’ upload to GCS, update Firestore job record to `completed`/`failed`, send FCM push notification to user's device(s) |
| 15 | Implement job routes | 2h | `jobs.ts`: `POST /jobs` (validate input, check quota, check idempotency, upload to GCS via signed URL, dispatch to correct AI service, return job record), `GET /jobs/:id` (return job status + signed output URL if complete), `GET /jobs?status=processing` (list user's active/recent jobs for reattachment) |
| 16 | Write backend tests | 2h | Unit tests for each service (mock external APIs). Integration test for job creation в†’ webhook в†’ completion flow. Test idempotency key deduplication. Test quota enforcement |
| 17 | Deploy backend to Cloud Run | 1.5h | Dockerfile, Cloud Run config, set env vars (vendor API keys, GCS bucket, Firebase project). Verify health endpoint. Set up staging environment |

### Phase 2: Core Package вЂ” Client Services (Days 5вЂ“6)

| # | Task | Time | Description |
|---|------|------|-------------|
| 18 | Implement `bff_client.dart` | 2h | Dio client targeting BFF. Auth interceptor injects Firebase Auth ID token. Logging interceptor. **Retry interceptor: only retries GET requests and poll requests. Never retries POST /jobs вЂ” instead uses idempotency keys.** Timeout: 30s for job creation, 10s for status polls |
| 19 | Implement `api_exceptions.dart` | 0.5h | Typed exceptions: `RateLimitException`, `QuotaExceededException`, `TimeoutException`, `AuthException`, `ProcessingFailedException` with error codes and user-facing messages |
| 20 | Implement Drift database + job persistence | 2h | `app_database.dart` with `jobs_table.dart` (id, bffJobId, status, modelId, inputLocalPath, outputLocalPath, idempotencyKey, createdAt, updatedAt) and `history_table.dart` (id, appId, inputThumbPath, outputThumbPath, modelId, createdAt, metadata JSON). DAO methods: insertJob, updateJobStatus, getActiveJobs, getJobById, insertHistory, getHistory(paginated) |
| 21 | Implement `job_service.dart` | 2h | **Core job lifecycle orchestrator**: (1) compress image per `image_constraints.dart`, (2) generate idempotency key (UUID), (3) persist job locally in Drift as `pending`, (4) call BFF `POST /jobs` with idempotency key, (5) update local job with BFF job ID, set status `uploading`в†’`processing`, (6) poll `GET /jobs/:id` with 3s interval + exponential backoff (max 120s), (7) on completion: download output via signed URL в†’ save to local file в†’ update Drift status to `completed` в†’ insert into history table. **On app relaunch**: query Drift for jobs with status `processing`/`uploading`, reattach polling via BFF `GET /jobs/:id` |
| 22 | Implement `image_service.dart` | 1.5h | **All file-path-based, no Uint8List in public API.** Methods: `pickImage() в†’ Future<String?>` (returns temp file path), `compressImage(String inputPath, {required ImageConstraints constraints}) в†’ Future<String>` (returns compressed file path, uses `flutter_image_compress` in isolate, validates max pixel count/file size/format, converts HEICв†’JPEG), `saveToGallery(String filePath) в†’ Future<bool>`, `generateThumbnail(String filePath, {int maxDim = 300}) в†’ Future<String>` (for history display) |
| 23 | Implement `subscription_service.dart` | 1.5h | RevenueCat wrapper using **public SDK key only**. Methods: `init()`, `getSubscriptionStatus()`, `purchasePackage(Package)`, `restorePurchases()`, `getOfferings()`. Listens to RevenueCat listener for status changes. **No server-side secret in Flutter.** |
| 24 | Implement `analytics_service.dart` | 0.5h | Firebase Analytics wrapper. Events: `photo_picked`, `job_created`, `job_completed`, `job_failed`, `subscription_shown`, `subscription_purchased`, `export_saved`, `export_shared` |
| 25 | Write core package tests | 2h | Mock BFF client for `job_service` tests: test full lifecycle, test reattach on relaunch, test idempotency key generation, test failure/timeout handling. Test `image_service` compression with sample images. Test Drift DAO operations. Test `subscription_service` with mock RevenueCat |

### Phase 3: Shared UI Components (Day 7)

| # | Task | Time | Description |
|---|------|------|-------------|
| 26 | Implement `app_theme.dart` + `app_colors.dart` | 1h | Material 3 base theme data that apps can extend. Shared color tokens for consistent branding. Dark mode support |
| 27 | Implement `before_after_slider.dart` | 2h | **File-path-based**: accepts two file paths, decodes to display resolution (not full resolution) using `ResizeImage`, renders with draggable divider. Disposes decoded images properly to avoid memory leaks |
| 28 | Implement `processing_overlay.dart` | 1h | Full-screen semi-transparent overlay with animated progress indicator, status text (uploading/processing/finalizing), and cancel button |
| 29 | Implement `paywall_sheet.dart` + `subscription_disclosure.dart` | 1.5h | Bottom sheet paywall configurable per app (title, features, product IDs). `subscription_disclosure.dart`: required App Store subscription terms text (auto-renewal, manage/cancel links, privacy policy, terms of use) вЂ” must be visible before purchase |
| 30 | Implement `onboarding_page.dart` | 1h | Reusable onboarding page template with image, title, description. Apps compose their own onboarding screens using this |
| 31 | Implement remaining shared widgets | 1.5h | `image_picker_sheet.dart` (camera/gallery bottom sheet), `export_share_sheet.dart` (save to library / share via system share sheet вЂ” file-path-based), `error_dialog.dart`, `subscription_badge.dart` |
| 32 | Write widget tests | 1h | Test `before_after_slider` rendering + interaction, `paywall_sheet` displays correct products, `subscription_disclosure` contains required legal text |

### Phase 4: App 1 вЂ” AI Background Remover (Days 8вЂ“9)

| # | Task | Time | Description |
|---|------|------|-------------|
| 33 | Implement `main.dart` + `app.dart` + Firebase init | 1h | ProviderScope, Firebase.initializeApp, Firebase Auth anonymous sign-in (for BFF auth), RevenueCat init with public key, GoRouter setup, app-specific theme (blue accent) |
| 34 | Implement onboarding + settings screens | 1.5h | 3-page onboarding: (1) "Remove backgrounds instantly", (2) "Replace with any background", (3) paywall with free trial CTA. Settings: manage subscription, restore purchases, privacy policy, terms, app version |
| 35 | Implement `home_screen.dart` | 1h | Hero CTA to pick photo, recent results grid (from Drift history), subscription status badge |
| 36 | Implement `bg_removal_service.dart` | 1.5h | Orchestrates: `imageService.pickImage()` в†’ `imageService.compressImage()` в†’ `jobService.createJob(model: 'remove-bg', inputPath: compressed)` в†’ wait for completion в†’ download output PNG with transparency. Handles all error states with user-facing messages |
| 37 | Implement `compositor_service.dart` | 2h | **On-device background replacement** using Flutter Canvas/CustomPainter. Load foreground PNG (with transparency) + chosen background в†’ composite в†’ save to temp file. Supports: solid colors, gradients, bundled background images, custom photo from gallery. All rendering in isolate for large images |
| 38 | Implement `editor_screen.dart` | 2h | Shows removal result on checkerboard (transparency), before/after slider, background replacement options (color picker, gradient picker, image grid, custom photo), composite preview, export button |
| 39 | Implement `backgrounds_screen.dart` + grid widget | 1h | Grid of bundled background images (lazy-loaded thumbnails), tap to preview composite, search/filter by category |
| 40 | Write bg_remover tests | 1.5h | Test `bg_removal_service` lifecycle with mocked job service. Test `compositor_service` produces valid output file. Widget test for home screen rendering |

### Phase 5: App 2 вЂ” AI Photo Enhancer (Days 10вЂ“11)

| # | Task | Time | Description |
|---|------|------|-------------|
| 41 | Implement `main.dart` + `app.dart` + Firebase init | 1h | Same pattern as bg_remover but with green accent theme, enhancer-specific routes |
| 42 | Implement onboarding + settings screens | 1.5h | 3-page onboarding: (1) "Upscale photos to crystal clarity", (2) "AI removes noise and sharpens", (3) paywall |
| 43 | Implement `enhance_mode.dart` + mode-to-model mapping | 1h | Enum: `upscale2x`, `upscale4x`, `denoise`, `sharpen`, `auto`. Each maps to specific Replicate model version + parameters from the model matrix. Include input validation per mode (e.g., upscale4x rejects images > 2MP) |
| 44 | Implement `enhance_service.dart` | 2h | Maps selected mode to model + params, calls `jobService.createJob(model: modeMapping.modelId, params: modeMapping.params, inputPath: compressed)`. For `auto` mode: chains upscale в†’ denoise as sequential BFF jobs. Handles per-mode error messages and fallback behavior per model matrix |
| 45 | Implement `home_screen.dart` + `enhance_screen.dart` | 2h | Home: pick photo + mode selector chips + intensity slider (maps to model params). Enhance: processing overlay в†’ before/after slider в†’ export. Shows actual enhancement metadata (2Г— upscaled, noise reduced by X) |
| 46 | Implement `history_screen.dart` + `history_provider.dart` | 1.5h | Paginated grid from Drift `history_table`. Shows thumbnail, mode used, date. Tap to view full before/after. Swipe to delete (removes files + DB record) |
| 47 | Write photo_enhancer tests | 1.5h | Test mode в†’ model mapping. Test `enhance_service` with mocked job service for each mode. Test history provider reads from Drift correctly |

### Phase 6: App 3 вЂ” AI Old Photo Restorer (Days 12вЂ“13)

| # | Task | Time | Description |
|---|------|------|-------------|
| 48 | Implement `main.dart` + `app.dart` + Firebase init | 1h | Amber/warm accent theme, restorer-specific routes |
| 49 | Implement onboarding + settings screens | 1.5h | 3-page onboarding: (1) "Bring old photos back to life", (2) "AI restores faces and removes scratches", (3) paywall |
| 50 | Implement `restore_service.dart` вЂ” multi-step pipeline | 2h | **Restoration pipeline as sequential BFF jobs**: Step 1: scratch/damage repair via `microsoft/bringing-old-photos-back-to-life` в†’ Step 2: face restoration via `tencentarc/gfpgan` (if face toggle enabled). Each step is a separate BFF job, output of step 1 becomes input of step 2. If step 1 model fails, skip to step 2 (graceful degradation per model matrix). Pipeline state persisted in Drift so it can resume after app relaunch |
| 51 | Implement `colorize_service.dart` | 1h | Optional step 3: colorize B&W output via `arielreplicate/deoldify_image`. Separate BFF job. User explicitly opts in from restore result screen |
| 52 | Implement `home_screen.dart` + `restore_screen.dart` | 2h | Home: pick photo (include camera for scanning physical photos). Restore: `pipeline_progress.dart` showing multi-step progress (repair в†’ faces в†’ colorize), face toggle, before/after slider at each step, final export |
| 53 | Implement `colorize_screen.dart` | 1h | Shows colorization result with before(B&W)/after(color) slider, intensity note, export |
| 54 | Implement custom widgets | 1h | `damage_indicator.dart` (visual overlay hint), `face_toggle.dart`, `pipeline_progress.dart` (multi-step progress bar with step labels) |
| 55 | Write photo_restorer tests | 1.5h | Test pipeline orchestration with mocked job service (step chaining, failure at each step, graceful degradation). Test colorize as optional step |

### Phase 7: Job Lifecycle Resilience + Background Handling (Day 14)

| # | Task | Time | Description |
|---|------|------|-------------|
| 56 | Implement job reattachment on app relaunch | 2h | In each app's `main.dart` initialization: query Drift for jobs with status `uploading`/`processing`. For each, call BFF `GET /jobs/:id` to get current status. If completed: download output, update local state. If still processing: resume polling. If failed/expired: mark as failed with user-visible message. Show notification banner for completed jobs found on relaunch |
| 57 | Implement background download via URLSession | 2h | Use `flutter_downloader` or platform channel to iOS `URLSession.background(withIdentifier:)` for downloading large output files. Register for download completion callbacks. This ensures downloads complete even if app is suspended |
| 58 | Implement local notification for job completion | 1h | When BFF sends FCM push (from webhook handler), show local notification if app is backgrounded. Tapping notification deep-links to result screen for the completed job |
| 59 | Implement job cleanup + storage management | 1h | On app launch: delete temp files older than 7 days. Drift migration to clean stale jobs older than 30 days. Show storage usage in settings. Allow manual "Clear cache" |

### Phase 8: Subscription + Paywall Polish (Day 15)

| # | Task | Time | Description |
|---|------|------|-------------|
| 60 | Implement paywall gating per app | 1.5h | Free tier: 3 enhancements/day (enforced server-side via quota middleware). Pro: unlimited. Gate on job creation вЂ” show paywall before processing if quota exceeded and not subscribed. Paywall shows remaining free uses |
| 61 | Implement subscription restoration flow | 1h | Settings в†’ Restore Purchases в†’ RevenueCat `restorePurchases()` в†’ update UI. Handle edge cases: no previous purchase, different Apple ID, family sharing |
| 62 | Implement subscription status sync | 1h | On app launch + on resume: sync RevenueCat status. BFF verifies subscription server-side via RevenueCat API for quota decisions. Handle subscription expiry gracefully (downgrade to free tier, don't delete data) |
| 63 | Add subscription disclosure to all paywalls | 0.5h | Ensure every paywall screen includes: subscription terms, price, renewal period, cancel instructions, links to privacy policy and terms of use. Required for App Store approval |

### Phase 9: Testing (Days 16вЂ“17)

| # | Task | Time | Description |
|---|------|------|-------------|
| 64 | Integration tests: job lifecycle | 2h | Test full flow: pick image в†’ create job в†’ poll в†’ complete в†’ download в†’ history. Test reattach after simulated app restart. Test network loss mid-upload (should show error, allow retry with same idempotency key). Test timeout handling |
| 65 | Integration tests: subscription flows | 2h | Test with RevenueCat sandbox: purchase в†’ verify entitlement в†’ job quota increases. Test restore. Test expired subscription в†’ downgrade. Test paywall display at quota boundary. Verify subscription_disclosure visible |
| 66 | Integration tests: large files + edge cases | 2h | Test with 20MB HEIC photo: verify compression, verify no OOM. Test with 1Г—1 pixel image (edge case). Test unsupported format (BMP, TIFF) в†’ graceful error. Test rapid successive job creation (idempotency). Test concurrent jobs from same user |
| 67 | Device testing: physical iOS device | 2h | Run all 3 apps on physical device. Test camera picker, photo library picker. Test app backgrounding during processing в†’ relaunch в†’ reattach. Test save to library permission flow. Test share sheet. Verify memory usage stays reasonable (Instruments) |
| 68 | Widget + golden tests | 2h | Golden tests for before/after slider, paywall sheet, processing overlay, onboarding pages. Widget tests for all custom widgets. Verify dark mode rendering |

### Phase 10: App Store Preparation (Day 18)

| # | Task | Time | Description |
|---|------|------|-------------|
| 69 | App Store Connect setup per app | 2h | Create 3 app records in App Store Connect. Configure: app name, subtitle, category (Photography), age rating, keywords. Set up auto-renewable subscription product per app (weekly, monthly, yearly) with introductory offer (3-day free trial). Create subscription group per app |
| 70 | RevenueCat project setup per app | 1.5h | Create RevenueCat project. Add iOS app with App Store Connect shared secret. Configure offerings per app (matching subscription products). Set up **separate** public API keys per app. Verify test environment sandbox purchases work. Configure server-side RevenueCat webhook to validate subscriptions for BFF quota checks |
| 71 | Privacy + compliance per app | 1.5h | Per app: fill out App Store privacy nutrition labels (photos accessed, analytics collected, account info for subscriptions). Review `PrivacyInfo.xcprivacy` entries match actual SDK usage. Write App Store reviewer notes explaining: what the app does, test account credentials, how to test subscription, how to test AI features (include test images) |
| 72 | Build + archive + TestFlight | 2h | Configure Fastlane per app: match signing, build_app, upload_to_testflight. Run first TestFlight build for each app. Verify all 3 install and launch correctly on TestFlight |

---

## 4. Summary

| Phase | Days | Tasks | Focus |
|-------|------|-------|-------|
| 0: Setup | 1 | 1вЂ“6 | Monorepo, shells, iOS config |
| 1: Backend | 2вЂ“4 | 7вЂ“17 | BFF proxy, auth, jobs, webhooks, storage |
| 2: Core client | 5вЂ“6 | 18вЂ“25 | BFF client, job lifecycle, image service, subscriptions |
| 3: Shared UI | 7 | 26вЂ“32 | Reusable widgets (no screens) |
| 4: BG Remover | 8вЂ“9 | 33вЂ“40 | App 1 with compositing pipeline |
| 5: Enhancer | 10вЂ“11 | 41вЂ“47 | App 2 with modeв†’model mapping + history |
| 6: Restorer | 12вЂ“13 | 48вЂ“55 | App 3 with multi-step pipeline |
| 7: Resilience | 14 | 56вЂ“59 | Job reattach, background downloads, notifications |
| 8: Subscriptions | 15 | 60вЂ“63 | Paywall gating, restore, sync, disclosure |
| 9: Testing | 16вЂ“17 | 64вЂ“68 | Integration, device, edge case, golden tests |
| 10: App Store | 18 | 69вЂ“72 | ASC setup, RevenueCat, privacy, TestFlight |

**72 tasks, ~18 working days, ~115 files**

### How Each Critique Point Is Addressed

| # | Critique | Resolution |
|---|----------|------------|
| 1 | API keys in Flutter client | **Phase 1**: Full backend/BFF owns all vendor secrets. Flutter only has RevenueCat public SDK key and BFF URL |
| 2 | No video support | **Scope note** at top: explicitly photo-only for v1, video deferred to follow-up ticket |
| 3 | Incomplete feature mapping | **Model matrix table** in Section 1 with exact model versions, input limits, output formats, and fallback behavior per app. Compositing pipeline added for bg_remover |
| 4 | Dangerous retry on billable POSTs | **Task 10**: idempotency layer on backend. **Task 18**: retry interceptor only retries GETs, never POST /jobs. Client sends idempotency key on every job creation |
| 5 | No job persistence/reattach | **Tasks 20-21**: Drift DB for local job persistence. **Task 56**: reattachment on app relaunch. **Task 57**: background downloads via URLSession. **Task 58**: FCM push on completion |
| 6 | History without real storage | **Task 20**: Drift SQLite DB with history table. History screen reads from Drift. Output files persisted immediately on completion |
| 7 | Memory-hostile Uint8List APIs | **All services use file paths**, not Uint8List. `image_service` compresses in isolate. `before_after_slider` decodes to display size via ResizeImage. Hard caps in `image_constraints.dart` |
| 8 | Over-shared screens/providers | **shared_ui is widgets-only**, no screens. Each app owns its own screens, providers, onboarding, settings. Core package is pure domain/network, no Riverpod providers |
| 9 | Replicate polling only | **Task 13**: sync-first mode, falls back to async+webhook. **Task 14**: webhook handler for completion notification |
| 10 | Inadequate testing | **Phase 9**: 5 dedicated test tasks covering job lifecycle, subscription flows, large files, device testing, widget/golden tests |
| 11 | Incomplete App Store prep | **Phase 10**: ASC setup, RevenueCat offerings per app, privacy manifests, reviewer notes, TestFlight builds |