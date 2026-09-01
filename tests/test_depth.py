from app.depth import depth_output_path


def test_depth_output_path_naming(tmp_path):
    src = tmp_path / "hero shot.png"
    src.write_bytes(b"x")
    out = depth_output_path(src, tmp_path / "depth")
    assert out.parent == tmp_path / "depth"
    assert out.name.startswith("hero shot-") and out.name.endswith("-depth.png")
    assert out == depth_output_path(src, tmp_path / "depth")  # stable for same file
