/** Closed default-workload oracle, cross-checked against the legacy call-through baseline.
 * Private intrinsic gates add no foreign callback and are not counted as removed live nodes. */
export const VF1_BASELINE={
  "reader/aux.ReadSourceDescriptor": {
    "actual": {
      "challenge": 51,
      "channel": 50,
      "owner": 52,
      "provider": 34,
      "scope": 8,
      "scopeCheck": 8,
      "command": 1,
      "root": 0,
      "proof": 0,
      "pack": 0
    },
    "liveChecks": 53,
    "internal": 8,
    "peakBytes": 1034970,
    "traceCount": 507,
    "traceDigest": "7d1f5b0530ee3ca44edc32873aa1ca7c05ba839d36ec1f82dec32b91d3547c28"
  },
  "reader/aux.ReadSealedSource": {
    "actual": {
      "challenge": 57,
      "channel": 56,
      "owner": 58,
      "provider": 36,
      "scope": 10,
      "scopeCheck": 10,
      "command": 2,
      "root": 0,
      "proof": 0,
      "pack": 0
    },
    "liveChecks": 59,
    "internal": 10,
    "peakBytes": 1034970,
    "traceCount": 562,
    "traceDigest": "6f6d47df2e593c0d817dec03d2fb3066663e9f3179db23d1d5bc0e9bcd2a8b78"
  },
  "reader/aux.ReadSourceRanges": {
    "actual": {
      "challenge": 537,
      "channel": 536,
      "owner": 538,
      "provider": 407,
      "scope": 119,
      "scopeCheck": 119,
      "command": 2,
      "root": 1,
      "proof": 2,
      "pack": 1
    },
    "liveChecks": 539,
    "internal": 234,
    "peakBytes": 1034970,
    "traceCount": 5169,
    "traceDigest": "bbd1baa783ee03b39cc1cb4ca1487bc83821b38ed52bb4e05fd404a5648c87a2"
  },
  "authority-broker/aux.ReadSourceDescriptor": {
    "actual": {
      "challenge": 51,
      "channel": 50,
      "owner": 52,
      "provider": 34,
      "scope": 8,
      "scopeCheck": 8,
      "command": 1,
      "root": 0,
      "proof": 0,
      "pack": 0
    },
    "liveChecks": 53,
    "internal": 8,
    "peakBytes": 1043712,
    "traceCount": 507,
    "traceDigest": "790418b52ae7a7b9e9264b9af34b76264617b46f19a252d08ae75bccc0205b3e"
  },
  "authority-broker/aux.ReadSealedSource": {
    "actual": {
      "challenge": 57,
      "channel": 56,
      "owner": 58,
      "provider": 36,
      "scope": 10,
      "scopeCheck": 10,
      "command": 2,
      "root": 0,
      "proof": 0,
      "pack": 0
    },
    "liveChecks": 59,
    "internal": 10,
    "peakBytes": 1043712,
    "traceCount": 562,
    "traceDigest": "42c923ceb60c7e64c0426a628cc2ec4c5245127f632adb5ee74a1bf4ce0aecac"
  },
  "authority-broker/aux.ReadSourceRanges": {
    "actual": {
      "challenge": 537,
      "channel": 536,
      "owner": 538,
      "provider": 407,
      "scope": 119,
      "scopeCheck": 119,
      "command": 2,
      "root": 1,
      "proof": 2,
      "pack": 1
    },
    "liveChecks": 539,
    "internal": 234,
    "peakBytes": 1043712,
    "traceCount": 5169,
    "traceDigest": "e5b43879f21e79cf74a1114335c603696acd06db3d3359ee1beef9e60fc7a344"
  }
};
export const VF1_CALLSITES=[
 {site:"connected-provider",source:"CwcLb1Binding.providerGate",order:"current > inspect/live > now > row"},
 {site:"connected-scope",source:"CwcCReadScope.#checkGate / CwcLb1Binding.checkScope",order:"registry > providerGate > now > checkScope/live > prepaid ledger.check/providerGate"},
 {site:"connected-command-pre/post",source:"CwcLb1Binding.command",order:"inspect/live > copyData > inspect/live"},
 {site:"receive/begin/general-inspect/ready/general/finish",source:"CwcLb0Session",order:"complete verification; never replaced"}
];
