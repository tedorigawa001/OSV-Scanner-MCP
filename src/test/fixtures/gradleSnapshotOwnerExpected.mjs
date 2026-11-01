/** Reviewed exact-artifact evidence, freshly resolved with JDK 21.0.13+9 on 2026-11-01.
 * Approval data, not a survey output. The normal collector must never refresh these pins.
 * Unknown artifact/class/signature/method digests require explicit review.
 */
export const ownerTupleArtifacts={
  "8.11.1": {
    "gradle": "8abc5c441eec849e658981f573356ef0c1bd32e2293cc0b5335967ccb0abf682",
    "kgp": "0f7357bc5ccc8e3681ec3b4643c70cad2883b246c8b7af7d6d971c41e3934f2d",
    "implementation": "8129f62cb7c627b5ce82187e42a6d87c42952bc7ba64b805a3547f6852319662",
    "events": "c1c16d062e1b5d181de812770c31ca58ce031efe86787a45bba4dcfc9d39ed2e",
    "tooling": "031c21afdf65bbe6d66d396c591e736eb30ec19f7fe2a151ad4bcb7b1d5833af",
    "bta": "57ed50220e78ec39e8a80014330f295e5485b5638c1129af9ed7d53d7858c5c2",
    "stdlib": "fb169596659a518357c4b2c16f43dc75ab1c4980565ed4b4a317a050e5e39006"
  },
  "9.2.1": {
    "gradle": "37054573063abb60c5401d761491c17c404f2eb875485274c9087185f6fb9445",
    "kgp": "7607ee5c7a0ca53fa592ee7c540ee808962a7bad8fee9ed78fe674841463d95d",
    "implementation": "5d325b5c2c5d4bc8bf44145d24eb4d4beb060d13d11ebe48898936ed5cd1564e",
    "events": "922c0b26bd4eab50e91136287e94757ad69af3d0ecd77bdb1c305b6c030a797b",
    "tooling": "a1710a09ccca7610d7d003472eb2a6db0bc89e4f988891c0aaabc5dafbf5f448",
    "bta": "fd9947b3a17621a86fabd953af87f34bd2bb7f8b26dae92c1ed7be7472f44c3b",
    "stdlib": "8836ccffd3585fadda9901244b20d42901d2f3cd581058d8434e2ffabcf3a3e7"
  }
};
export const ownerArtifactEvidence={
  "8129f62cb7c627b5ce82187e42a6d87c42952bc7ba64b805a3547f6852319662": {
    "org.jetbrains.kotlin.gradle.tasks.KotlinCompile": {
      "classSha256": "a48744491d421c8e8ea0b31c4fa41f8d7e446abfacfa2a2aca6d61bb74028087",
      "signatureSha256": "36366bccc7df3eb388c62f8488233294af411832cc2db8a7476a567f740b8642",
      "compileBytecodeSha256": "4bd0fa620c2251fd499894b3dbd38756a6344e272d9ab6848e4e24b1f81e7989"
    },
    "org.jetbrains.kotlin.gradle.tasks.KotlinCompile$ClasspathSnapshotProperties": {
      "classSha256": "eff91b682cf119fff9e6c5841a0e57386027292b939dc8a6b92e5bb886e81dae",
      "signatureSha256": "5d9b89dd4a7a6c89b7dab471e4471b9c68f8433ce7752c3a4b3dcaefc2c63179"
    },
    "org.jetbrains.kotlin.gradle.plugin.KotlinCompilerArgumentsProducer": {
      "classSha256": "805611ca9b9fd41856455e1fae9b45a3c9763e2d91d2f6e91d26d589ee6e4b0e",
      "signatureSha256": "4c482d566356aa079cd05b437a0a8af2974b6ae86381e3deef02581cd299644c"
    }
  },
  "0f7357bc5ccc8e3681ec3b4643c70cad2883b246c8b7af7d6d971c41e3934f2d": {
    "org.jetbrains.kotlin.gradle.plugin.KotlinCompilerPluginSupportPlugin": {
      "classSha256": "5097fa9fd1b2dc64604adda0c47aadd45ddac411f124d880089e828abdbf0ae0",
      "signatureSha256": "d906d62f38e559f90aa55af342093e2ae888017126071a1579a8ade54e57eb5a"
    }
  },
  "8abc5c441eec849e658981f573356ef0c1bd32e2293cc0b5335967ccb0abf682": {
    "org.gradle.api.Task": {
      "classSha256": "95274cc149c1434961eb633c222354dcb9bbed9110c028ec8927e7718cf4efe3",
      "signatureSha256": "7f9c0a2c9e491c496e867d743fcec97986aa32690043de12ed2a991e682e461d"
    },
    "org.gradle.api.tasks.TaskInputs": {
      "classSha256": "b886cf863b5282482b4000aa30f9a3e6d554abf9b66dd3deec0bc07cbca6d7cc",
      "signatureSha256": "653e0c1649c08fdea0e32a5003e9a6814477efbc617c32e112914c2097f457af"
    },
    "org.gradle.work.InputChanges": {
      "classSha256": "9a1c92f863309f74cd07a544e09b59c90de038da6f071e36d8c3394f16c321c3",
      "signatureSha256": "0a6e811123586ee602f94d1dbec1e9f6d9aa9c7ab7716f4d98e56005f5f52b36"
    },
    "org.gradle.api.artifacts.transform.TransformAction": {
      "classSha256": "d37ea55a17612b36b299dae0c24e91c0da1c9aa967664d4f683e59f484162ae8",
      "signatureSha256": "7b6088f7ae38d734c1d4b993f318a0c313aa7eeece4caacdf13a11e4a3c11664"
    }
  },
  "c1c16d062e1b5d181de812770c31ca58ce031efe86787a45bba4dcfc9d39ed2e": {
    "org.gradle.build.event.BuildEventsListenerRegistry": {
      "classSha256": "f21db3740d302a5e85b492fc2c9cdf477d86ebdb602f4480c75bd55705b88240",
      "signatureSha256": "cd0d271e36d1c3c9db62996c627d6380c4625dacd461d2802aa19a87f07dd838"
    }
  },
  "031c21afdf65bbe6d66d396c591e736eb30ec19f7fe2a151ad4bcb7b1d5833af": {
    "org.gradle.tooling.events.task.TaskFinishEvent": {
      "classSha256": "b02df515f6d7f1d5af1d0df0451e6eb6f3ae3bb012205482d51f23c0c3d4a653",
      "signatureSha256": "e879af6a29219b3e21ab4deaa32a5bd26bad26d1045363ecb320326fb2bf84d5"
    },
    "org.gradle.tooling.events.task.TaskSuccessResult": {
      "classSha256": "54338912254b0ccb5b7aed32a49cd06dcb6c4642e7ea1fcb8c60cffbda426277",
      "signatureSha256": "314c67e765ebd2b0f6173fe6460e62ed70b1abb89e1098b307062983ac412ef6"
    }
  },
  "57ed50220e78ec39e8a80014330f295e5485b5638c1129af9ed7d53d7858c5c2": {
    "org.jetbrains.kotlin.buildtools.api.CompilationService": {
      "classSha256": "af15f7beb3d922359d1f8b766bb2c63592fefb1ee3120bb90f78f8473688059d",
      "signatureSha256": "a029f9375058f402fcd782f23fc50652ca190d199b6cac9a396ff575419bc09e"
    },
    "org.jetbrains.kotlin.buildtools.api.jvm.JvmCompilationConfiguration": {
      "classSha256": "b22a9ea9519855ecafaf853a29ee3681727e9c8d619fd3c4e3b62d2e6b1d3f73",
      "signatureSha256": "fc42e92e61c8c81151301223654f520a795b245521ff6040e4f1608186d8c027"
    },
    "org.jetbrains.kotlin.buildtools.api.jvm.ClasspathSnapshotBasedIncrementalCompilationApproachParameters": {
      "classSha256": "c066ab84250b960f1a7251e9fa8f55221a5b642373ffdff22549356c9275b175",
      "signatureSha256": "af097b6d5cea37d3733398bb7f0df20435a68824b74cfbe5eeb39c7f6a22ba24"
    }
  },
  "5d325b5c2c5d4bc8bf44145d24eb4d4beb060d13d11ebe48898936ed5cd1564e": {
    "org.jetbrains.kotlin.gradle.tasks.KotlinCompile": {
      "classSha256": "09009026cfc09ac4f64ba9507838a40870e4d5c93069857be84578189a985dde",
      "signatureSha256": "cc80a72742237e226dfe733256cfc8bf723974f5c126f979dbda20eee1569152",
      "compileBytecodeSha256": "99a0757e32d408e609d4cc36c5f49ff6e8c1b3138bee0ecfc5b9eb416acfe67c"
    },
    "org.jetbrains.kotlin.gradle.tasks.KotlinCompile$ClasspathSnapshotProperties": {
      "classSha256": "eed0ce60ac451165ca9d51735d13455af0bc98216ebf49c432911ba94db91e0b",
      "signatureSha256": "779f88e1fa82b983283d2d1d1ff8b88a2c5fcad9d8e0e55b5cb3d7c8aad564a0"
    },
    "org.jetbrains.kotlin.gradle.plugin.KotlinCompilerArgumentsProducer": {
      "classSha256": "5820b9960ae39731403433c4ac2414383f911adb7e4d9e2d127443132021ffb1",
      "signatureSha256": "4c482d566356aa079cd05b437a0a8af2974b6ae86381e3deef02581cd299644c"
    }
  },
  "7607ee5c7a0ca53fa592ee7c540ee808962a7bad8fee9ed78fe674841463d95d": {
    "org.jetbrains.kotlin.gradle.plugin.KotlinCompilerPluginSupportPlugin": {
      "classSha256": "df111227b1f984b69364345dd9181cc04570beb878181cefec24806f87757893",
      "signatureSha256": "d906d62f38e559f90aa55af342093e2ae888017126071a1579a8ade54e57eb5a"
    }
  },
  "37054573063abb60c5401d761491c17c404f2eb875485274c9087185f6fb9445": {
    "org.gradle.api.Task": {
      "classSha256": "4d4f029aa0cdd975155965e424ca6aafd8974dc74a0faa29e65d04732e74661c",
      "signatureSha256": "2ed9ad56147bd3edb1be074ca829fcaa43baf9e2ad3ced1580476877d6adec1b"
    },
    "org.gradle.api.tasks.TaskInputs": {
      "classSha256": "f16975a331c0bac34f1521660bacae122401014b41bb085a283eed1c7b72e934",
      "signatureSha256": "653e0c1649c08fdea0e32a5003e9a6814477efbc617c32e112914c2097f457af"
    },
    "org.gradle.work.InputChanges": {
      "classSha256": "f725f2ce21759156124472d178d933ce76ee8af5a584f0704c92aa9b61984c59",
      "signatureSha256": "0a6e811123586ee602f94d1dbec1e9f6d9aa9c7ab7716f4d98e56005f5f52b36"
    },
    "org.gradle.api.artifacts.transform.TransformAction": {
      "classSha256": "69126b9770e5b1376c5cea64e675b29ec2759e1eaddbc04b202e92eda4a4619e",
      "signatureSha256": "7b6088f7ae38d734c1d4b993f318a0c313aa7eeece4caacdf13a11e4a3c11664"
    }
  },
  "922c0b26bd4eab50e91136287e94757ad69af3d0ecd77bdb1c305b6c030a797b": {
    "org.gradle.build.event.BuildEventsListenerRegistry": {
      "classSha256": "8554e035dedd30f2f7f2484ab426d690d5a0f254f029ef5ab5ccf0544243046a",
      "signatureSha256": "cd0d271e36d1c3c9db62996c627d6380c4625dacd461d2802aa19a87f07dd838"
    }
  },
  "a1710a09ccca7610d7d003472eb2a6db0bc89e4f988891c0aaabc5dafbf5f448": {
    "org.gradle.tooling.events.task.TaskFinishEvent": {
      "classSha256": "cae95f62db38f9cb40df9abe7fa7abe65e660923275d5e5cb25d2ccb061516c2",
      "signatureSha256": "5a4d0a11c720c6989bf26c2f3176ec14dd622cbf2b3ac97c39bed327ee958cae"
    },
    "org.gradle.tooling.events.task.TaskSuccessResult": {
      "classSha256": "c5692e5af3af4af4feda00475e6c1a1cfa0c358e02ef4e869d3952d647284c9b",
      "signatureSha256": "314c67e765ebd2b0f6173fe6460e62ed70b1abb89e1098b307062983ac412ef6"
    }
  },
  "fd9947b3a17621a86fabd953af87f34bd2bb7f8b26dae92c1ed7be7472f44c3b": {
    "org.jetbrains.kotlin.buildtools.api.CompilationService": {
      "classSha256": "35ac6f10c5e835ee41ab6dde71eb39b0562747902141617004f846aa716f508b",
      "signatureSha256": "95f9a90881febf0adc2820896629b22ec5f6ce0698625321cbdbff6143120a5d"
    },
    "org.jetbrains.kotlin.buildtools.api.jvm.JvmCompilationConfiguration": {
      "classSha256": "87f9394b75597aac967088e72e6dec74f05e19c5a217f552aa2ab187ca039274",
      "signatureSha256": "fc42e92e61c8c81151301223654f520a795b245521ff6040e4f1608186d8c027"
    },
    "org.jetbrains.kotlin.buildtools.api.jvm.ClasspathSnapshotBasedIncrementalCompilationApproachParameters": {
      "classSha256": "6a94e707c24b66d667a5976c9e1d7da92c2ebf59c030df71d7401543c99dd66a",
      "signatureSha256": "af097b6d5cea37d3733398bb7f0df20435a68824b74cfbe5eeb39c7f6a22ba24"
    }
  }
};
// JDK whose javap output the pins above correspond to; another toolchain needs its own reviewed profile.
export const ownerJdkProfile={
  "java": {
    "sha256": "0f642542ea1f0be6957557c0db96653ec128113bb5a4aaa7c2534d1d72ddb51f",
    "version": "openjdk 21.0.13 2026-10-20 LTS\nOpenJDK Runtime Environment Temurin-21.0.13+9 (build 21.0.13+9-LTS)\nOpenJDK 64-Bit Server VM Temurin-21.0.13+9 (build 21.0.13+9-LTS, mixed mode, sharing)"
  },
  "javac": {
    "sha256": "40425235eaac99cccf8ed57522d946313d8b5200161d1faf846b3e60d554c2ed",
    "version": "javac 21.0.13"
  },
  "javap": {
    "sha256": "1bc4474ca5b28394346fe2ad79b10eac15ef8d7017d1c22f46139e7438a86e32",
    "version": "21.0.13"
  }
};
