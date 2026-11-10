-- 工具开关种子（docs/requirements.md §5.1 status/灰度）
-- 只覆盖后端承载的工具；离线项 enabled=false（前端首页不展示，FR 清单见 tools-spec.md）。
-- 使用 ON CONFLICT DO NOTHING，重复执行安全。

INSERT INTO tool_flags (tool_id, enabled, sort, min_version, gray_percent) VALUES
    ('video-compress',        true,  10, '1.0.0', 100),
    ('video-trim',            true,  20, '1.0.0', 100),
    ('video-crop',            true,  30, '1.0.0', 100),
    ('video-to-gif',          true,  40, '1.0.0', 100),
    ('video-frames',          true,  50, '1.0.0', 100),
    ('video-info',            true,  60, '1.0.0', 100),
    ('video-extract-audio',   true,  70, '1.0.0', 100),
    ('video-watermark',       true,  80, '1.0.0', 100),
    ('video-convert',         true,  90, '1.0.0', 100),
    ('video-rotate',          true, 100, '1.0.0', 100),
    ('video-speed',           true, 110, '1.0.0', 100),
    ('video-concat',          true, 120, '1.0.0', 100),
    ('video-subtitle',        false, 130, '1.0.0', 0),
    ('gif-edit',              false, 140, '1.0.0', 0),
    ('images-to-video',       false, 150, '1.0.0', 0),
    ('image-to-pdf',          true, 200, '1.0.0', 100),
    ('image-remove-bg',       false, 210, '1.0.0', 0),
    ('fx-rates',              true, 300, '1.0.0', 100),
    ('http-proxy',            true, 310, '1.0.0', 100)
ON CONFLICT (tool_id) DO NOTHING;
