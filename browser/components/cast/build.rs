fn main() {
    prost_build::compile_protos(&["src/cast_channel.proto"], &["src/"])
        .expect("Failed to compile protobuf definitions");
}
