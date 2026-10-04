from importlib.resources import files

import pytest


SCHEMAS = {
    "ssm-ir-v0.1": "ssm-ir-v0.1",
    "ssm-control-v0.1": "ssm-control-v0.1",
    "ssm-provider-v0.1": "ssm-provider-v0.1",
    "ssm-actuation-receipt-v0.1": "ssm-actuation-receipt-v0.1",
    "mvp-run-manifest-v0.1": "mvp-run-manifest-v0.1",
}


def test_contract_files_are_package_resources():
    root = files("phosphor_spacetime").joinpath("schemas")
    missing = [f"{name}.schema.json" for name in SCHEMAS if not root.joinpath(f"{name}.schema.json").is_file()]
    assert missing == []


def test_ir_schema_has_expected_version():
    from phosphor_spacetime.contracts import load_schema

    schema = load_schema("ssm-ir-v0.1")
    assert schema["properties"]["schema_version"]["const"] == "ssm-ir-v0.1"


def test_invalid_ir_payload_is_rejected():
    from phosphor_spacetime.contracts import validate_payload

    with pytest.raises(Exception):
        validate_payload("ssm-ir-v0.1", {"schema_version": "ssm-ir-v0.1"})
