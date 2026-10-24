# Local face model attribution

Inference runs entirely on the application backend CPU. No cloud inference, API
key, GPU, AWS account, or external biometric provider is used.

| Artifact | Upstream / license | SHA-256 |
| --- | --- | --- |
| `face_detection_yunet_2023mar.onnx` | [OpenCV Zoo YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet), MIT, Copyright2020 Shiqi Yu | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| `face_recognition_sface_2021dec.onnx` | [OpenCV Zoo SFace](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface), Apache2.0 | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

The SFace directory README explicitly states that **all files** in its directory
use Apache2.0, including the selected weights. Full model licenses are retained
alongside this notice. Hashes are the upstream Git LFS SHA-256 object identifiers,
not hashes invented for locally modified weights. Installer fetches official
GitHub media URLs and rejects bytes that do not match those pinned hashes.
If restricted egress blocks Git LFS media, installation reads the ONNX bytes
from [a pinned ordinary-blob mirror](https://github.com/sun0801/YuNet_SFace2/tree/d96f7798acb772a8383267b471d2ff2bd0d32701).
Both mirror files were verified byte-for-byte by the same official SHA-256
identifiers. No mirror source code is installed or executed.

OpenCV4.13.0.92 uses the official maintained Python CPU DNN/ONNX runtime through
`FaceDetectorYN` and `FaceRecognizerSF` (OpenCV Apache2.0; wheel includes its own
third-party notices). NumPy2.2.6 uses BSD-3-Clause. These permissive licenses permit
commercial project integration subject to their notices/terms. Licenses are not
a promise of accuracy, fair performance, training-data privacy clearance or legal
permission to process employee biometrics; operators still need an appropriate
consent/legal basis and deployment review.

SFace is a MobileFaceNet face-embedding model with SFace loss. YuNet supplies a
face box and five landmarks; the official SFace `alignCrop` creates a112px aligned
crop before producing a128-value normalized identity embedding. Detection alone
never verifies attendance. Cosine similarity is a model-specific score, not a
probability; the upstream example cutoff0.363 is a starting point and must be
validated with the intended workforce and hardware before operational reliance.

Neither YuNet nor SFace performs presentation-attack detection. A live camera UI,
multiple frames, blinking and head movements do not prove robust liveness.
Printed photos, screens or replayed frames may defeat this system. The application
must not describe local identity matching as anti-spoofing or reliable liveness.
