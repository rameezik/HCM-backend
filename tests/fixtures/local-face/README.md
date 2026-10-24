# Public-domain test photographs

These photographs are **automated test fixtures only**. They are never inserted into the application database by setup or served as real employees. They exercise actual local face detection, alignment and embedding inference; replaying them does not prove live-camera provenance, anti-spoofing, deployment accuracy or the identity of a physical employee.

- `astronaut.jpg`: NASA portrait of Eileen Collins, converted to JPEG from scikit-image v0.25.2 `skimage/data/astronaut.png`. scikit-image documents this image as “No known copyright restrictions, released into the public domain”: https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/_fetchers.py#L382 . Original NASA Great Images source is linked there: https://flic.kr/p/r9qvLn .
- `astronaut-transformed-1.jpg` and `astronaut-transformed-2.jpg`: resizes/brightness adjustments and JPEG encodings of that same public-domain photograph, used to check embedding stability.
- `grace_hopper.jpg`: official US Navy portrait of Rear Admiral Grace Hopper (a US Government work in the public domain), distributed as Matplotlib v3.10.3 sample data: https://github.com/matplotlib/matplotlib/blob/v3.10.3/lib/matplotlib/mpl-data/sample_data/grace_hopper.jpg . The official portrait is reproduced with US Navy attribution at https://commons.wikimedia.org/wiki/File:Commodore_Grace_M._Hopper,_USN_(covered).jpg .

- `grace_hopper-transformed-1.jpg` and `grace_hopper-transformed-2.jpg`: resizes/brightness adjustments and JPEG encodings of the same public-domain official portrait.

The pictured people have no association with this application and have not enrolled as employees. No likeness, endorsement or suitability claim is made. A matching photograph and its transformed copy are a deterministic inference regression test, not a performance benchmark.

`no-face.jpg` is a generated blank diagnostic frame; `two-faces.jpg` places the same public-domain NASA portrait side by side to test exactly-one-face rejection. These are diagnostic image inputs, not simulated recognition outcomes or business records.
