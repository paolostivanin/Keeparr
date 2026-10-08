# Applied only when the release build is shrunk (-Pkeeparr.minify=true).
# kotlinx.serialization keeps its generated serializers through its own consumer rules; WorkManager, Room and Compose
# ship theirs. Add rules here only for reflection that a device run shows being stripped.
-keepattributes *Annotation*, InnerClasses, Signature
